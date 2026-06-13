import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { createHash } from "node:crypto";
import type {
  AiDecision,
  BoothRecord,
  ChatIdentity,
  Conversation,
  InboundMessageRecord,
  KeywordGroup,
  MessageIntegrationConfig,
  OutboundMessage,
  PendingWorkOrderSession,
  Person,
  Ticket,
  TicketReply,
  TicketTimelineItem,
  UserGroup
} from "../domain/types";
import { normalizeAiPromptConfig } from "../domain/ai-config";
import { keywordRuleSetsOf, normalizeKeywordGroups } from "../domain/keyword-config";
import type { TicketSummary } from "../domain/ticket-summary";
import { defaultConfig, type AppConfig } from "../seed";
import { normalizeWxautoMcpConfig, syncWxautoMcpMessageIntegration } from "../integrations/wxauto/config";
import type { AppState } from "../domain/app-state";
import { createTicketService, type SubmitTicketInput } from "../services/ticket-service";
import { processWechatWatchtowerMessage, type WatchtowerResult } from "../services/wechat-watchtower-service";
import {
  autoAcceptanceFeedbackText,
  autoAcceptanceProcessingText,
  autoAcceptanceReceiptBody,
  isTicketDueForAutoAcceptance,
  normalizeAutoAcceptanceConfig
} from "../services/auto-acceptance-service";
import type { IntakeMessageInput } from "../services/message-intake-service";
import { getDatabasePool, type DatabaseConnection, withDatabaseTransaction } from "./connection";

type Row = RowDataPacket & Record<string, unknown>;
type SqlValue = string | number | boolean | Date | null;

const CURRENT_EXHIBITION_ID = "current";

async function rows<T extends Row>(connection: DatabaseConnection, sql: string, params: SqlValue[] = []) {
  const [result] = await connection.execute<T[]>(sql, params);
  return result;
}

async function execute(connection: DatabaseConnection, sql: string, params: SqlValue[] = []) {
  const [result] = await connection.execute<ResultSetHeader>(sql, params);
  return result;
}

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

function bool(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function iso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function requiredIso(value: unknown) {
  return iso(value) ?? new Date().toISOString();
}

function dateOrNull(value?: string) {
  return value ? new Date(value) : null;
}

function stableId(prefix: string, value: string) {
  return `${prefix}-${createHash("sha256").update(value).digest("base64url")}`;
}

function mergedConfig(config?: Partial<AppConfig>): AppConfig {
  const defaults = defaultConfig();
  const incoming = config ?? {};
  const promptConfig = normalizeAiPromptConfig(incoming);
  const wxautoMcp = normalizeWxautoMcpConfig(incoming.wxautoMcp, incoming.messageIntegrations);
  const messageIntegrations = syncWxautoMcpMessageIntegration(
    incoming.messageIntegrations?.length ? incoming.messageIntegrations : defaults.messageIntegrations,
    wxautoMcp
  );
  return {
    ...defaults,
    ...incoming,
    issueTypes: incoming.issueTypes?.length ? incoming.issueTypes : defaults.issueTypes,
    aiModels: incoming.aiModels?.length ? incoming.aiModels : defaults.aiModels,
    messageIntegrations,
    wxautoMcp,
    userGroups: incoming.userGroups?.length ? incoming.userGroups : defaults.userGroups,
    keywordGroups: normalizeKeywordGroups(incoming.keywordGroups?.length ? incoming.keywordGroups : defaults.keywordGroups),
    aiPromptTemplates: promptConfig.aiPromptTemplates,
    aiPromptDefaults: promptConfig.aiPromptDefaults,
    autoAcceptance: normalizeAutoAcceptanceConfig(incoming.autoAcceptance),
    assignmentRules: incoming.assignmentRules?.length ? incoming.assignmentRules : defaults.assignmentRules
  };
}

async function latestConfig(connection: DatabaseConnection): Promise<AppConfig> {
  const [row] = await rows<Row>(
    connection,
    "SELECT config_json FROM app_config_versions ORDER BY created_at DESC LIMIT 1"
  );
  if (!row) return defaultConfig();
  return mergedConfig(parseJsonValue<Partial<AppConfig>>(row.config_json, {}));
}

async function readBooths(connection: DatabaseConnection): Promise<BoothRecord[]> {
  const boothRows = await rows<Row>(
    connection,
    "SELECT booth_number, company_name, company_short_name, sales_owner, builder FROM exhibition_booths WHERE enabled = true ORDER BY booth_number"
  );
  return boothRows.map((row) => ({
    boothNumber: String(row.booth_number),
    companyName: String(row.company_name),
    companyShortName: String(row.company_short_name ?? row.company_name),
    salesOwner: String(row.sales_owner ?? ""),
    builder: String(row.builder ?? "")
  }));
}

async function readPeople(connection: DatabaseConnection): Promise<Person[]> {
  const peopleRows = await rows<Row>(connection, "SELECT * FROM people ORDER BY created_at");
  return peopleRows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    phone: String(row.phone),
    role: row.role as Person["role"],
    groupId: row.group_id ? String(row.group_id) : undefined,
    groupName: String(row.group_name_snapshot ?? ""),
    groupLocked: bool(row.group_locked),
    nameConflict: parseJsonValue<Person["nameConflict"] | undefined>(row.name_conflict, undefined),
    boothScope: parseJsonValue<string[] | undefined>(row.booth_scope, undefined),
    enabled: bool(row.enabled),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at)
  }));
}

async function readChatIdentities(connection: DatabaseConnection): Promise<ChatIdentity[]> {
  const identityRows = await rows<Row>(connection, "SELECT * FROM chat_identities ORDER BY first_seen_at");
  return identityRows.map((row) => ({
    id: String(row.id),
    platform: row.platform as ChatIdentity["platform"],
    externalUserId: String(row.external_user_id),
    displayName: String(row.display_name),
    isTemporary: bool(row.is_temporary),
    personId: row.person_id ? String(row.person_id) : undefined,
    verifiedBy: row.verified_by as ChatIdentity["verifiedBy"],
    verifiedAt: iso(row.verified_at),
    firstSeenAt: requiredIso(row.first_seen_at),
    lastSeenAt: requiredIso(row.last_seen_at)
  }));
}

async function readConversations(connection: DatabaseConnection): Promise<Conversation[]> {
  const conversationRows = await rows<Row>(connection, "SELECT * FROM conversations ORDER BY created_at");
  const links = await rows<Row>(connection, "SELECT conversation_id, person_id FROM conversation_people");
  return conversationRows.map((row) => ({
    id: String(row.id),
    platform: row.platform as Conversation["platform"],
    type: row.type as Conversation["type"],
    externalConversationId: String(row.external_conversation_id),
    title: row.title ? String(row.title) : undefined,
    linkedPersonIds: links
      .filter((link) => link.conversation_id === row.id)
      .map((link) => String(link.person_id)),
    defaultNotify: bool(row.default_notify),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at)
  }));
}

async function readTickets(connection: DatabaseConnection): Promise<Ticket[]> {
  const ticketRows = await rows<Row>(connection, "SELECT * FROM tickets ORDER BY created_at");
  const feedbackRows = await rows<Row>(connection, "SELECT * FROM ticket_feedback_users ORDER BY feedback_at");
  const replyRows = await rows<Row>(connection, "SELECT * FROM ticket_replies ORDER BY created_at");
  const timelineRows = await rows<Row>(connection, "SELECT * FROM ticket_timeline ORDER BY created_at");
  const decisionRows = await rows<Row>(connection, "SELECT * FROM ai_decisions ORDER BY created_at");

  return ticketRows.map((row) => {
    const ticketId = String(row.id);
    return {
      id: ticketId,
      title: String(row.title),
      boothNumber: String(row.booth_number),
      companyName: String(row.company_name),
      companyShortName: String(row.company_short_name),
      description: String(row.description),
      imageUrls: parseJsonValue<string[]>(row.image_urls, []),
      issueType: String(row.issue_type),
      submitterId: String(row.submitter_id),
      submitterName: String(row.submitter_name),
      submitterPhone: row.submitter_phone ? String(row.submitter_phone) : undefined,
      reporterPersonId: row.reporter_person_id ? String(row.reporter_person_id) : undefined,
      reporterChatIdentityId: row.reporter_chat_identity_id ? String(row.reporter_chat_identity_id) : undefined,
      sourceConversationId: row.source_conversation_id ? String(row.source_conversation_id) : undefined,
      feedbackUsers: feedbackRows
        .filter((feedback) => feedback.ticket_id === ticketId)
        .map((feedback) => ({
          userId: String(feedback.user_id),
          userName: String(feedback.user_name),
          phone: feedback.phone ? String(feedback.phone) : undefined,
          feedbackAt: requiredIso(feedback.feedback_at)
        })),
      status: row.status as Ticket["status"],
      acceptedAt: iso(row.accepted_at),
      handlerId: row.handler_id ? String(row.handler_id) : undefined,
      handlerName: row.handler_name ? String(row.handler_name) : undefined,
      handlerPhone: row.handler_phone ? String(row.handler_phone) : undefined,
      assignmentGroup: row.assignment_group ? String(row.assignment_group) : undefined,
      urgeCount: Number(row.urge_count ?? 0),
      lastUrgedAt: iso(row.last_urged_at),
      urgeLevel: Number(row.urge_level ?? 0) as Ticket["urgeLevel"],
      priorityScore: Number(row.priority_score ?? 0),
      aiDecisions: decisionRows
        .filter((decision) => decision.ticket_id === ticketId)
        .map((decision) => ({
          modelId: decision.model_id as AiDecision["modelId"],
          scenario: decision.scenario as AiDecision["scenario"],
          confidence: Number(decision.confidence ?? 0),
          action: decision.action as AiDecision["action"],
          issueType: decision.issue_type ? String(decision.issue_type) : undefined,
          matchedTicketId: decision.matched_ticket_id ? String(decision.matched_ticket_id) : undefined,
          suggestion: decision.suggestion ? String(decision.suggestion) : undefined,
          latencyMs: Number(decision.latency_ms ?? 0)
        })),
      replies: replyRows
        .filter((reply) => reply.ticket_id === ticketId)
        .map((reply) => ({
          id: String(reply.id),
          ticketId,
          authorId: String(reply.author_id),
          authorName: String(reply.author_name),
          authorPhone: reply.author_phone ? String(reply.author_phone) : undefined,
          role: reply.role as TicketReply["role"],
          body: String(reply.body),
          imageUrls: parseJsonValue<string[]>(reply.image_urls, []),
          createdAt: requiredIso(reply.created_at)
        })),
      timeline: timelineRows
        .filter((item) => item.ticket_id === ticketId)
        .map((item) => ({
          id: String(item.id),
          ticketId,
          type: item.type as TicketTimelineItem["type"],
          body: String(item.body),
          createdAt: requiredIso(item.created_at),
          actorName: String(item.actor_name)
        })),
      createdAt: requiredIso(row.created_at),
      updatedAt: requiredIso(row.updated_at)
    };
  });
}

function ticketFeedbackFromRows(feedbackRows: Row[]) {
  const feedbackByTicket = new Map<string, Ticket["feedbackUsers"]>();
  for (const feedback of feedbackRows) {
    const ticketId = String(feedback.ticket_id);
    const list = feedbackByTicket.get(ticketId) ?? [];
    list.push({
      userId: String(feedback.user_id),
      userName: String(feedback.user_name),
      phone: feedback.phone ? String(feedback.phone) : undefined,
      feedbackAt: requiredIso(feedback.feedback_at)
    });
    feedbackByTicket.set(ticketId, list);
  }

  return feedbackByTicket;
}

function ticketSummaryFromRow(row: Row, feedbackByTicket: Map<string, Ticket["feedbackUsers"]>): TicketSummary {
  const ticketId = String(row.id);
  return {
    id: ticketId,
    title: String(row.title),
    boothNumber: String(row.booth_number),
    companyName: String(row.company_name),
    companyShortName: String(row.company_short_name),
    description: String(row.description),
    issueType: String(row.issue_type),
    submitterId: String(row.submitter_id),
    submitterName: String(row.submitter_name),
    submitterPhone: row.submitter_phone ? String(row.submitter_phone) : undefined,
    feedbackUsers: feedbackByTicket.get(ticketId) ?? [],
    status: row.status as Ticket["status"],
    acceptedAt: iso(row.accepted_at),
    handlerId: row.handler_id ? String(row.handler_id) : undefined,
    handlerName: row.handler_name ? String(row.handler_name) : undefined,
    handlerPhone: row.handler_phone ? String(row.handler_phone) : undefined,
    assignmentGroup: row.assignment_group ? String(row.assignment_group) : undefined,
    urgeCount: Number(row.urge_count ?? 0),
    lastUrgedAt: iso(row.last_urged_at),
    urgeLevel: Number(row.urge_level ?? 0) as Ticket["urgeLevel"],
    priorityScore: Number(row.priority_score ?? 0),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at)
  };
}

async function readTicketSummaries(connection: DatabaseConnection): Promise<TicketSummary[]> {
  const ticketRows = await rows<Row>(
    connection,
    `SELECT
      id, title, booth_number, company_name, company_short_name, description, issue_type,
      submitter_id, submitter_name, submitter_phone, status, accepted_at, handler_id,
      handler_name, handler_phone, assignment_group, urge_count, last_urged_at,
      urge_level, priority_score, created_at, updated_at
    FROM tickets
    ORDER BY priority_score DESC, COALESCE(last_urged_at, '1970-01-01') DESC, created_at ASC`
  );
  if (ticketRows.length === 0) return [];

  const ticketIds = ticketRows.map((row) => String(row.id));
  const placeholders = ticketIds.map(() => "?").join(",");
  const feedbackRows = await rows<Row>(
    connection,
    `SELECT * FROM ticket_feedback_users WHERE ticket_id IN (${placeholders}) ORDER BY feedback_at`,
    ticketIds
  );
  const feedbackByTicket = ticketFeedbackFromRows(feedbackRows);
  return ticketRows.map((row) => ticketSummaryFromRow(row, feedbackByTicket));
}

async function ticketFromRow(connection: DatabaseConnection, ticketId: string, row: Row): Promise<Ticket> {
  const feedbackRows = await rows<Row>(connection, "SELECT * FROM ticket_feedback_users WHERE ticket_id = ? ORDER BY feedback_at", [ticketId]);
  const replyRows = await rows<Row>(connection, "SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at", [ticketId]);
  const timelineRows = await rows<Row>(connection, "SELECT * FROM ticket_timeline WHERE ticket_id = ? ORDER BY created_at", [ticketId]);
  const decisionRows = await rows<Row>(connection, "SELECT * FROM ai_decisions WHERE ticket_id = ? ORDER BY created_at", [ticketId]);

  return {
    id: ticketId,
    title: String(row.title),
    boothNumber: String(row.booth_number),
    companyName: String(row.company_name),
    companyShortName: String(row.company_short_name),
    description: String(row.description),
    imageUrls: parseJsonValue<string[]>(row.image_urls, []),
    issueType: String(row.issue_type),
    submitterId: String(row.submitter_id),
    submitterName: String(row.submitter_name),
    submitterPhone: row.submitter_phone ? String(row.submitter_phone) : undefined,
    reporterPersonId: row.reporter_person_id ? String(row.reporter_person_id) : undefined,
    reporterChatIdentityId: row.reporter_chat_identity_id ? String(row.reporter_chat_identity_id) : undefined,
    sourceConversationId: row.source_conversation_id ? String(row.source_conversation_id) : undefined,
    feedbackUsers: ticketFeedbackFromRows(feedbackRows).get(ticketId) ?? [],
    status: row.status as Ticket["status"],
    acceptedAt: iso(row.accepted_at),
    handlerId: row.handler_id ? String(row.handler_id) : undefined,
    handlerName: row.handler_name ? String(row.handler_name) : undefined,
    handlerPhone: row.handler_phone ? String(row.handler_phone) : undefined,
    assignmentGroup: row.assignment_group ? String(row.assignment_group) : undefined,
    urgeCount: Number(row.urge_count ?? 0),
    lastUrgedAt: iso(row.last_urged_at),
    urgeLevel: Number(row.urge_level ?? 0) as Ticket["urgeLevel"],
    priorityScore: Number(row.priority_score ?? 0),
    aiDecisions: decisionRows.map((decision) => ({
      modelId: decision.model_id as AiDecision["modelId"],
      scenario: decision.scenario as AiDecision["scenario"],
      confidence: Number(decision.confidence ?? 0),
      action: decision.action as AiDecision["action"],
      issueType: decision.issue_type ? String(decision.issue_type) : undefined,
      matchedTicketId: decision.matched_ticket_id ? String(decision.matched_ticket_id) : undefined,
      suggestion: decision.suggestion ? String(decision.suggestion) : undefined,
      latencyMs: Number(decision.latency_ms ?? 0)
    })),
    replies: replyRows.map((reply) => ({
      id: String(reply.id),
      ticketId,
      authorId: String(reply.author_id),
      authorName: String(reply.author_name),
      authorPhone: reply.author_phone ? String(reply.author_phone) : undefined,
      role: reply.role as TicketReply["role"],
      body: String(reply.body),
      imageUrls: parseJsonValue<string[]>(reply.image_urls, []),
      createdAt: requiredIso(reply.created_at)
    })),
    timeline: timelineRows.map((item) => ({
      id: String(item.id),
      ticketId,
      type: item.type as TicketTimelineItem["type"],
      body: String(item.body),
      createdAt: requiredIso(item.created_at),
      actorName: String(item.actor_name)
    })),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at)
  };
}

async function readTicketById(connection: DatabaseConnection, ticketId: string): Promise<Ticket | undefined> {
  const [row] = await rows<Row>(connection, "SELECT * FROM tickets WHERE id = ? LIMIT 1", [ticketId]);
  if (!row) return undefined;
  return ticketFromRow(connection, ticketId, row);
}

async function readResolvedTicketByIdForUpdate(connection: DatabaseConnection, ticketId: string): Promise<Ticket | undefined> {
  const [row] = await rows<Row>(
    connection,
    "SELECT * FROM tickets WHERE id = ? AND status = ? LIMIT 1 FOR UPDATE",
    [ticketId, "已解决"]
  );
  if (!row) return undefined;
  return ticketFromRow(connection, ticketId, row);
}

async function readOpenTicketsForBooth(connection: DatabaseConnection, boothNumber: string): Promise<Ticket[]> {
  const ticketRows = await rows<Row>(
    connection,
    "SELECT id FROM tickets WHERE booth_number = ? AND status <> ? ORDER BY created_at",
    [boothNumber, "已关闭"]
  );
  const tickets: Ticket[] = [];
  for (const row of ticketRows) {
    const ticket = await readTicketById(connection, String(row.id));
    if (ticket) tickets.push(ticket);
  }
  return tickets;
}

async function clearTicketChildren(connection: DatabaseConnection, ticketId: string) {
  await execute(connection, "DELETE FROM ticket_feedback_users WHERE ticket_id = ?", [ticketId]);
  await execute(connection, "DELETE FROM ticket_replies WHERE ticket_id = ?", [ticketId]);
  await execute(connection, "DELETE FROM ticket_timeline WHERE ticket_id = ?", [ticketId]);
  await execute(connection, "DELETE FROM ai_decisions WHERE ticket_id = ?", [ticketId]);
}

async function upsertTicketGraph(connection: DatabaseConnection, ticket: Ticket, now = new Date()) {
  await execute(
    connection,
    `INSERT INTO tickets (
      id, title, booth_number, company_name, company_short_name, description, image_urls, issue_type,
      submitter_id, submitter_name, submitter_phone, reporter_person_id, reporter_chat_identity_id,
      source_conversation_id, status, accepted_at, handler_id, handler_name, handler_phone,
      assignment_group, urge_count, last_urged_at, urge_level, priority_score, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      booth_number = VALUES(booth_number),
      company_name = VALUES(company_name),
      company_short_name = VALUES(company_short_name),
      description = VALUES(description),
      image_urls = VALUES(image_urls),
      issue_type = VALUES(issue_type),
      submitter_id = VALUES(submitter_id),
      submitter_name = VALUES(submitter_name),
      submitter_phone = VALUES(submitter_phone),
      reporter_person_id = VALUES(reporter_person_id),
      reporter_chat_identity_id = VALUES(reporter_chat_identity_id),
      source_conversation_id = VALUES(source_conversation_id),
      status = VALUES(status),
      accepted_at = VALUES(accepted_at),
      handler_id = VALUES(handler_id),
      handler_name = VALUES(handler_name),
      handler_phone = VALUES(handler_phone),
      assignment_group = VALUES(assignment_group),
      urge_count = VALUES(urge_count),
      last_urged_at = VALUES(last_urged_at),
      urge_level = VALUES(urge_level),
      priority_score = VALUES(priority_score),
      updated_at = VALUES(updated_at)`,
    [
      ticket.id,
      ticket.title,
      ticket.boothNumber,
      ticket.companyName,
      ticket.companyShortName,
      ticket.description,
      json(ticket.imageUrls),
      ticket.issueType,
      ticket.submitterId,
      ticket.submitterName,
      ticket.submitterPhone ?? null,
      ticket.reporterPersonId ?? null,
      ticket.reporterChatIdentityId ?? null,
      ticket.sourceConversationId ?? null,
      ticket.status,
      dateOrNull(ticket.acceptedAt),
      ticket.handlerId ?? null,
      ticket.handlerName ?? null,
      ticket.handlerPhone ?? null,
      ticket.assignmentGroup ?? null,
      ticket.urgeCount,
      dateOrNull(ticket.lastUrgedAt),
      ticket.urgeLevel,
      ticket.priorityScore,
      dateOrNull(ticket.createdAt) ?? now,
      dateOrNull(ticket.updatedAt) ?? now
    ]
  );

  await clearTicketChildren(connection, ticket.id);

  for (const feedback of ticket.feedbackUsers) {
    await execute(
      connection,
      `INSERT INTO ticket_feedback_users (
        id, ticket_id, user_id, user_name, phone, feedback_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        stableId("feedback", `${ticket.id}:${feedback.userId}`),
        ticket.id,
        feedback.userId,
        feedback.userName,
        feedback.phone ?? null,
        dateOrNull(feedback.feedbackAt) ?? now
      ]
    );
  }

  for (const reply of ticket.replies) {
    await execute(
      connection,
      `INSERT INTO ticket_replies (
        id, ticket_id, author_id, author_name, author_phone, role, body, image_urls, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reply.id,
        ticket.id,
        reply.authorId,
        reply.authorName,
        reply.authorPhone ?? null,
        reply.role,
        reply.body,
        json(reply.imageUrls),
        dateOrNull(reply.createdAt) ?? now
      ]
    );
  }

  for (const item of ticket.timeline) {
    await execute(
      connection,
      "INSERT INTO ticket_timeline (id, ticket_id, type, body, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [item.id, ticket.id, item.type, item.body, item.actorName, dateOrNull(item.createdAt) ?? now]
    );
  }

  for (const [index, decision] of ticket.aiDecisions.entries()) {
    await execute(
      connection,
      `INSERT INTO ai_decisions (
        id, ticket_id, model_id, scenario, confidence, action, issue_type, matched_ticket_id,
        suggestion, latency_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stableId("decision", `${ticket.id}:${index}:${decision.scenario}:${decision.action}`),
        ticket.id,
        decision.modelId,
        decision.scenario,
        decision.confidence,
        decision.action,
        decision.issueType ?? null,
        decision.matchedTicketId ?? null,
        decision.suggestion ?? null,
        decision.latencyMs,
        dateOrNull(ticket.updatedAt) ?? now
      ]
    );
  }
}

async function readInboundMessages(connection: DatabaseConnection): Promise<InboundMessageRecord[]> {
  const messageRows = await rows<Row>(connection, "SELECT * FROM inbound_messages ORDER BY created_at");
  return messageRows.map((row) => ({
    id: String(row.id),
    channel: row.channel as InboundMessageRecord["channel"],
    externalMessageId: row.external_message_id ? String(row.external_message_id) : undefined,
    senderId: row.sender_id ? String(row.sender_id) : undefined,
    senderName: String(row.sender_name),
    senderPhone: row.sender_phone ? String(row.sender_phone) : undefined,
    senderGroup: row.sender_group ? String(row.sender_group) : undefined,
    text: String(row.text),
    imageUrls: parseJsonValue<string[]>(row.image_urls, []),
    receivedAt: requiredIso(row.received_at),
    createdAt: requiredIso(row.created_at),
    reporterPersonId: row.reporter_person_id ? String(row.reporter_person_id) : undefined,
    reporterChatIdentityId: row.reporter_chat_identity_id ? String(row.reporter_chat_identity_id) : undefined,
    sourceConversationId: row.source_conversation_id ? String(row.source_conversation_id) : undefined,
    raw: parseJsonValue<Record<string, unknown> | undefined>(row.raw_payload, undefined),
    analysis: parseJsonValue<InboundMessageRecord["analysis"]>(row.analysis_json, {
      confidence: 0,
      suggestedAction: "ignore",
      reason: ""
    })
  }));
}

async function readPendingSessions(connection: DatabaseConnection): Promise<PendingWorkOrderSession[]> {
  const sessionRows = await rows<Row>(connection, "SELECT * FROM pending_work_order_sessions ORDER BY created_at");
  return sessionRows.map((row) => ({
    id: String(row.id),
    platform: row.platform as PendingWorkOrderSession["platform"],
    conversationId: String(row.conversation_id),
    chatIdentityId: String(row.chat_identity_id),
    originalMessageRecordId: row.original_message_record_id ? String(row.original_message_record_id) : undefined,
    draftText: String(row.draft_text),
    draftImages: parseJsonValue<string[]>(row.draft_images, []),
    identityGroup: row.identity_group ? String(row.identity_group) : undefined,
    contactName: row.contact_name ? String(row.contact_name) : undefined,
    contactPhone: row.contact_phone ? String(row.contact_phone) : undefined,
    personId: row.person_id ? String(row.person_id) : undefined,
    boothNumber: row.booth_number ? String(row.booth_number) : undefined,
    issueType: row.issue_type ? String(row.issue_type) : undefined,
    missingFields: parseJsonValue<PendingWorkOrderSession["missingFields"]>(row.missing_fields, []),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    lastPromptAt: iso(row.last_prompt_at)
  }));
}

async function readOutboundMessages(connection: DatabaseConnection): Promise<OutboundMessage[]> {
  const messageRows = await rows<Row>(connection, "SELECT * FROM outbound_messages ORDER BY created_at");
  return messageRows.map((row) => ({
    id: String(row.id),
    channel: row.channel as OutboundMessage["channel"],
    targetConversationId: row.target_conversation_id ? String(row.target_conversation_id) : undefined,
    targetChatIdentityId: row.target_chat_identity_id ? String(row.target_chat_identity_id) : undefined,
    targetName: String(row.target_name),
    text: String(row.text),
    relatedTicketId: row.related_ticket_id ? String(row.related_ticket_id) : undefined,
    relatedSessionId: row.related_session_id ? String(row.related_session_id) : undefined,
    status: row.status as OutboundMessage["status"],
    retryCount: Number(row.retry_count ?? 0),
    lastError: row.last_error ? String(row.last_error) : undefined,
    claimedAt: iso(row.claimed_at),
    sentAt: iso(row.sent_at),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at)
  }));
}

async function clearStateTables(connection: DatabaseConnection) {
  for (const table of [
    "ticket_feedback_users",
    "ticket_replies",
    "ticket_timeline",
    "ai_decisions",
    "message_analysis_logs",
    "wechat_order_logs",
    "pending_work_order_sessions",
    "outbound_messages",
    "inbound_messages",
    "conversation_people",
    "conversations",
    "chat_identities",
    "people",
    "tickets",
    "exhibition_booths",
    "exhibitions",
    "assignment_rules",
    "issue_types",
    "message_integrations",
    "ai_model_configs",
    "keyword_match_logs",
    "keyword_terms",
    "keyword_rule_sets",
    "keyword_rules",
    "keyword_groups",
    "user_groups"
  ]) {
    await execute(connection, `DELETE FROM ${table}`);
  }
}

async function writeBooths(connection: DatabaseConnection, booths: BoothRecord[], now: Date) {
  await execute(
    connection,
    "INSERT INTO exhibitions (id, name, status, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [CURRENT_EXHIBITION_ID, "当前展览", "active", null, null, now, now]
  );

  for (const booth of booths) {
    await execute(
      connection,
      `INSERT INTO exhibition_booths (
        id, exhibition_id, booth_number, company_name, company_short_name, sales_owner, builder,
        contact_name, contact_phone, raw_payload, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stableId("booth", booth.boothNumber),
        CURRENT_EXHIBITION_ID,
        booth.boothNumber,
        booth.companyName,
        booth.companyShortName,
        booth.salesOwner,
        booth.builder,
        null,
        null,
        null,
        true,
        now,
        now
      ]
    );
  }
}

async function writeConfig(connection: DatabaseConnection, config: AppConfig, now: Date) {
  const normalized = mergedConfig(config);

  for (const group of normalized.userGroups ?? []) {
    await execute(
      connection,
      `INSERT INTO user_groups (
        id, name, description, can_claim, can_process, can_accept, can_admin, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [group.id, group.name, group.description, group.canClaim, group.canProcess, group.canAccept, group.canAdmin ?? false, group.enabled, now, now]
    );
  }

  for (const issue of normalized.issueTypes) {
    await execute(
      connection,
      `INSERT INTO issue_types (
        id, name, urgency_minutes, priority_weight, assignment_group, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [issue.id, issue.name, issue.urgencyMinutes, issue.priorityWeight, issue.assignmentGroup ?? null, issue.enabled, now, now]
    );
  }

  for (const rule of normalized.assignmentRules) {
    await execute(
      connection,
      `INSERT INTO assignment_rules (
        id, booth_pattern, issue_type, handler_id, handler_name, group_name, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [rule.id, rule.boothPattern, rule.issueType, rule.handlerId, rule.handlerName, rule.groupName, true, now, now]
    );
  }

  for (const integration of normalized.messageIntegrations ?? []) {
    await execute(
      connection,
      `INSERT INTO message_integrations (
        id, channel, label, enabled, mcp_server_name, endpoint, secret_env, auto_create_tickets, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        integration.id,
        integration.channel,
        integration.label,
        integration.enabled,
        integration.mcpServerName,
        integration.endpoint ?? null,
        integration.secretEnv ?? null,
        integration.autoCreateTickets,
        now,
        now
      ]
    );
  }

  for (const model of normalized.aiModels) {
    await execute(
      connection,
      `INSERT INTO ai_model_configs (
        id, label, provider, endpoint, api_key_env, model_name, timeout_ms, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        model.id,
        model.label,
        model.provider,
        model.endpoint ?? null,
        model.apiKeyEnv ?? null,
        model.modelName,
        model.timeoutMs,
        model.enabled,
        now,
        now
      ]
    );
  }

  for (const group of normalized.keywordGroups ?? []) {
    await execute(
      connection,
      `INSERT INTO keyword_groups (id, name, description, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [group.id, group.name, group.description, group.enabled, now, now]
    );
    for (const ruleSet of keywordRuleSetsOf(group)) {
      await execute(
        connection,
        `INSERT INTO keyword_rule_sets (
          id, group_id, match_type, action, issue_type, priority, enabled,
          channels, conditions_json, action_config_json, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ruleSet.id,
          group.id,
          ruleSet.matchType,
          ruleSet.action,
          ruleSet.issueType ?? null,
          ruleSet.priority,
          ruleSet.enabled,
          ruleSet.channels ? json(ruleSet.channels) : null,
          ruleSet.conditions ? json(ruleSet.conditions) : null,
          ruleSet.actionConfig ? json(ruleSet.actionConfig) : null,
          ruleSet.sortOrder ?? 0,
          now,
          now
        ]
      );
      for (const term of ruleSet.terms) {
        await execute(
          connection,
          `INSERT INTO keyword_terms (
            id, rule_set_id, term, aliases, enabled, sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            term.id,
            ruleSet.id,
            term.value,
            term.aliases?.length ? json(term.aliases) : null,
            term.enabled,
            term.sortOrder ?? 0,
            now,
            now
          ]
        );
        await execute(
          connection,
          `INSERT INTO keyword_rules (
          id, group_id, keyword, match_type, action, issue_type, priority, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            stableId("kw", `${ruleSet.id}|${term.id}|${term.value}`),
            group.id,
            term.value,
            ruleSet.matchType,
            ruleSet.action,
            ruleSet.issueType ?? null,
            ruleSet.priority,
            term.enabled && ruleSet.enabled,
            now,
            now
          ]
        );
      }
    }
  }

  const serialized = json(normalized);
  const [latest] = await rows<Row>(
    connection,
    "SELECT config_json FROM app_config_versions ORDER BY created_at DESC LIMIT 1"
  );
  if (latest && json(parseJsonValue(latest.config_json, {})) === serialized) return;

  const timestamp = now.toISOString();
  await execute(
    connection,
    `INSERT INTO app_config_versions (
      id, version, config_json, operator_id, operator_name, change_summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      stableId("config", timestamp),
      timestamp,
      serialized,
      "system",
      "system",
      "Repository state sync",
      now
    ]
  );
}

async function writePeople(connection: DatabaseConnection, people: Person[], now: Date) {
  for (const person of people) {
    await execute(
      connection,
      `INSERT INTO people (
        id, name, phone, role, group_id, group_name_snapshot, group_locked, name_conflict, booth_scope, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        person.id,
        person.name,
        person.phone,
        person.role,
        person.groupId ?? null,
        person.groupName,
        person.groupLocked ?? false,
        person.nameConflict ? json(person.nameConflict) : null,
        person.boothScope ? json(person.boothScope) : null,
        person.enabled,
        dateOrNull(person.createdAt) ?? now,
        dateOrNull(person.updatedAt) ?? now
      ]
    );
  }
}

async function writeChatIdentities(connection: DatabaseConnection, identities: ChatIdentity[], now: Date) {
  for (const identity of identities) {
    await execute(
      connection,
      `INSERT INTO chat_identities (
        id, platform, external_user_id, display_name, is_temporary, person_id, verified_by,
        verified_at, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity.id,
        identity.platform,
        identity.externalUserId,
        identity.displayName,
        Boolean(identity.isTemporary),
        identity.personId ?? null,
        identity.verifiedBy ?? null,
        dateOrNull(identity.verifiedAt),
        dateOrNull(identity.firstSeenAt) ?? now,
        dateOrNull(identity.lastSeenAt) ?? now
      ]
    );
  }
}

async function writeConversations(connection: DatabaseConnection, conversations: Conversation[], now: Date) {
  for (const conversation of conversations) {
    await execute(
      connection,
      `INSERT INTO conversations (
        id, platform, type, external_conversation_id, title, default_notify, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conversation.id,
        conversation.platform,
        conversation.type,
        conversation.externalConversationId,
        conversation.title ?? null,
        conversation.defaultNotify,
        dateOrNull(conversation.createdAt) ?? now,
        dateOrNull(conversation.updatedAt) ?? now
      ]
    );

    for (const personId of conversation.linkedPersonIds) {
      await execute(
        connection,
        "INSERT INTO conversation_people (conversation_id, person_id, created_at) VALUES (?, ?, ?)",
        [conversation.id, personId, now]
      );
    }
  }
}

async function writeTickets(connection: DatabaseConnection, tickets: Ticket[], now: Date) {
  for (const ticket of tickets) {
    await execute(
      connection,
      `INSERT INTO tickets (
        id, title, booth_number, company_name, company_short_name, description, image_urls, issue_type,
        submitter_id, submitter_name, submitter_phone, reporter_person_id, reporter_chat_identity_id,
        source_conversation_id, status, accepted_at, handler_id, handler_name, handler_phone,
        assignment_group, urge_count, last_urged_at, urge_level, priority_score, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ticket.id,
        ticket.title,
        ticket.boothNumber,
        ticket.companyName,
        ticket.companyShortName,
        ticket.description,
        json(ticket.imageUrls),
        ticket.issueType,
        ticket.submitterId,
        ticket.submitterName,
        ticket.submitterPhone ?? null,
        ticket.reporterPersonId ?? null,
        ticket.reporterChatIdentityId ?? null,
        ticket.sourceConversationId ?? null,
        ticket.status,
        dateOrNull(ticket.acceptedAt),
        ticket.handlerId ?? null,
        ticket.handlerName ?? null,
        ticket.handlerPhone ?? null,
        ticket.assignmentGroup ?? null,
        ticket.urgeCount,
        dateOrNull(ticket.lastUrgedAt),
        ticket.urgeLevel,
        ticket.priorityScore,
        dateOrNull(ticket.createdAt) ?? now,
        dateOrNull(ticket.updatedAt) ?? now
      ]
    );

    for (const feedback of ticket.feedbackUsers) {
      await execute(
        connection,
        `INSERT INTO ticket_feedback_users (
          id, ticket_id, user_id, user_name, phone, feedback_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          stableId("feedback", `${ticket.id}:${feedback.userId}`),
          ticket.id,
          feedback.userId,
          feedback.userName,
          feedback.phone ?? null,
          dateOrNull(feedback.feedbackAt) ?? now
        ]
      );
    }

    for (const reply of ticket.replies) {
      await execute(
        connection,
        `INSERT INTO ticket_replies (
          id, ticket_id, author_id, author_name, author_phone, role, body, image_urls, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reply.id,
          ticket.id,
          reply.authorId,
          reply.authorName,
          reply.authorPhone ?? null,
          reply.role,
          reply.body,
          json(reply.imageUrls),
          dateOrNull(reply.createdAt) ?? now
        ]
      );
    }

    for (const item of ticket.timeline) {
      await execute(
        connection,
        "INSERT INTO ticket_timeline (id, ticket_id, type, body, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [item.id, ticket.id, item.type, item.body, item.actorName, dateOrNull(item.createdAt) ?? now]
      );
    }

    for (const [index, decision] of ticket.aiDecisions.entries()) {
      await execute(
        connection,
        `INSERT INTO ai_decisions (
          id, ticket_id, model_id, scenario, confidence, action, issue_type, matched_ticket_id,
          suggestion, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          stableId("decision", `${ticket.id}:${index}`),
          ticket.id,
          decision.modelId,
          decision.scenario,
          decision.confidence,
          decision.action,
          decision.issueType ?? null,
          decision.matchedTicketId ?? null,
          decision.suggestion ?? null,
          decision.latencyMs,
          dateOrNull(ticket.updatedAt) ?? now
        ]
      );
    }
  }
}

async function writeInboundMessages(connection: DatabaseConnection, records: InboundMessageRecord[], now: Date) {
  for (const record of records) {
    await execute(
      connection,
      `INSERT INTO inbound_messages (
        id, channel, external_message_id, sender_id, sender_name, sender_phone, sender_group, text,
        image_urls, received_at, created_at, reporter_person_id, reporter_chat_identity_id,
        source_conversation_id, raw_payload, analysis_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.channel,
        record.externalMessageId ?? null,
        record.senderId ?? null,
        record.senderName,
        record.senderPhone ?? null,
        record.senderGroup ?? null,
        record.text,
        json(record.imageUrls),
        dateOrNull(record.receivedAt) ?? now,
        dateOrNull(record.createdAt) ?? now,
        record.reporterPersonId ?? null,
        record.reporterChatIdentityId ?? null,
        record.sourceConversationId ?? null,
        record.raw ? json(record.raw) : null,
        json(record.analysis)
      ]
    );

    await execute(
      connection,
      `INSERT INTO message_analysis_logs (
        id, inbound_message_id, booth_number, issue_type, confidence, suggested_action, matched_ticket_id, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stableId("analysis", record.id),
        record.id,
        record.analysis.boothNumber ?? null,
        record.analysis.issueType ?? null,
        record.analysis.confidence,
        record.analysis.suggestedAction,
        record.analysis.matchedTicketId ?? null,
        record.analysis.reason,
        dateOrNull(record.createdAt) ?? now
      ]
    );

    await execute(
      connection,
      `INSERT INTO wechat_order_logs (
        id, inbound_message_id, channel, action, ticket_id, session_id, summary, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stableId("wechat-log", record.id),
        record.id,
        record.channel,
        record.analysis.suggestedAction,
        record.analysis.matchedTicketId ?? null,
        null,
        record.analysis.reason,
        record.analysis.suggestedAction === "ignore" ? "ignored" : "processed",
        dateOrNull(record.createdAt) ?? now
      ]
    );
  }
}

async function writePendingSessions(connection: DatabaseConnection, sessions: PendingWorkOrderSession[], now: Date) {
  for (const session of sessions) {
    await execute(
      connection,
      `INSERT INTO pending_work_order_sessions (
        id, platform, conversation_id, chat_identity_id, original_message_record_id, draft_text,
        draft_images, identity_group, contact_name, contact_phone, person_id, booth_number,
        issue_type, missing_fields, created_at, updated_at, last_prompt_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.platform,
        session.conversationId,
        session.chatIdentityId,
        session.originalMessageRecordId ?? null,
        session.draftText,
        json(session.draftImages),
        session.identityGroup ?? null,
        session.contactName ?? null,
        session.contactPhone ?? null,
        session.personId ?? null,
        session.boothNumber ?? null,
        session.issueType ?? null,
        json(session.missingFields),
        dateOrNull(session.createdAt) ?? now,
        dateOrNull(session.updatedAt) ?? now,
        dateOrNull(session.lastPromptAt)
      ]
    );
  }
}

async function writeOutboundMessages(connection: DatabaseConnection, messages: OutboundMessage[], now: Date) {
  for (const message of messages) {
    await execute(
      connection,
      `INSERT INTO outbound_messages (
        id, channel, target_conversation_id, target_chat_identity_id, target_name, text,
        related_ticket_id, related_session_id, status, retry_count, last_error, claimed_at,
        sent_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.channel,
        message.targetConversationId ?? null,
        message.targetChatIdentityId ?? null,
        message.targetName,
        message.text,
        message.relatedTicketId ?? null,
        message.relatedSessionId ?? null,
        message.status,
        message.retryCount,
        message.lastError ?? null,
        dateOrNull(message.claimedAt),
        dateOrNull(message.sentAt),
        dateOrNull(message.createdAt) ?? now,
        dateOrNull(message.updatedAt) ?? now
      ]
    );
  }
}

function ticketFeedbackTargetName(ticket: Ticket) {
  return ticket.sourceConversationId ?? ticket.submitterName;
}

async function queueTicketFeedbackOutbound(connection: DatabaseConnection, ticket: Ticket, text: string, now = new Date()) {
  const trimmedText = text.trim();
  if (!trimmedText) return;

  await execute(
    connection,
    `INSERT INTO outbound_messages (
      id, channel, target_conversation_id, target_chat_identity_id, target_name, text,
      related_ticket_id, related_session_id, status, retry_count, last_error, claimed_at,
      sent_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `outbound-${crypto.randomUUID()}`,
      "wechat",
      ticket.sourceConversationId ?? null,
      ticket.reporterChatIdentityId ?? null,
      ticketFeedbackTargetName(ticket),
      trimmedText,
      ticket.id,
      null,
      "pending",
      0,
      null,
      null,
      null,
      now,
      now
    ]
  );
}

async function queueProcessingGroupOutbound(connection: DatabaseConnection, ticket: Ticket, text: string, now = new Date()) {
  const trimmedText = text.trim();
  if (!trimmedText) return;

  await execute(
    connection,
    `INSERT INTO outbound_messages (
      id, channel, target_conversation_id, target_chat_identity_id, target_name, text,
      related_ticket_id, related_session_id, status, retry_count, last_error, claimed_at,
      sent_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `outbound-${crypto.randomUUID()}`,
      "wechat",
      null,
      null,
      ticket.assignmentGroup ?? ticket.handlerName ?? "刘基鑫",
      trimmedText,
      ticket.id,
      null,
      "pending",
      0,
      null,
      null,
      null,
      now,
      now
    ]
  );
}

async function appendTicketTimelineItem(connection: DatabaseConnection, item: TicketTimelineItem, now = new Date()) {
  await execute(
    connection,
    `INSERT INTO ticket_timeline (
      id, ticket_id, type, body, actor_name, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      item.id,
      item.ticketId,
      item.type,
      item.body,
      item.actorName,
      dateOrNull(item.createdAt) ?? now
    ]
  );
}

async function runAutoAcceptanceOnConnection(connection: DatabaseConnection, now = new Date()) {
  const config = await latestConfig(connection);
  const autoAcceptance = normalizeAutoAcceptanceConfig(config.autoAcceptance);
  if (!autoAcceptance.enabled) return [];

  const candidateRows = await rows<Row>(
    connection,
    "SELECT id FROM tickets WHERE status = ? ORDER BY updated_at ASC",
    ["已解决"]
  );
  const acceptedTicketIds: string[] = [];
  const nowIso = now.toISOString();

  for (const row of candidateRows) {
    const ticketId = String(row.id);
    const ticket = await readResolvedTicketByIdForUpdate(connection, ticketId);
    if (!ticket || !isTicketDueForAutoAcceptance(ticket, config, nowIso)) continue;

    const result = await execute(
      connection,
      "UPDATE tickets SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
      ["已关闭", now, ticket.id, "已解决"]
    );
    if (result.affectedRows < 1) continue;

    const closedTicket: Ticket = {
      ...ticket,
      status: "已关闭",
      updatedAt: nowIso
    };
    await appendTicketTimelineItem(connection, {
      id: `timeline-${crypto.randomUUID()}`,
      ticketId: ticket.id,
      type: "receipt",
      body: autoAcceptanceReceiptBody(autoAcceptance.timeoutMinutes),
      createdAt: nowIso,
      actorName: "系统"
    }, now);
    await queueTicketFeedbackOutbound(connection, closedTicket, autoAcceptanceFeedbackText(closedTicket, autoAcceptance.timeoutMinutes), now);
    await queueProcessingGroupOutbound(connection, closedTicket, autoAcceptanceProcessingText(closedTicket), now);
    acceptedTicketIds.push(ticket.id);
  }

  return acceptedTicketIds;
}

async function replaceConfigTables(connection: DatabaseConnection, config: AppConfig, now = new Date()) {
  for (const table of [
    "assignment_rules",
    "issue_types",
    "message_integrations",
    "ai_model_configs",
    "keyword_match_logs",
    "keyword_terms",
    "keyword_rule_sets",
    "keyword_rules",
    "keyword_groups",
    "user_groups"
  ]) {
    await execute(connection, `DELETE FROM ${table}`);
  }
  await writeConfig(connection, config, now);
}

async function upsertBoothRecords(connection: DatabaseConnection, booths: BoothRecord[], now = new Date()) {
  await execute(
    connection,
    `INSERT INTO exhibitions (id, name, status, starts_at, ends_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), updated_at = VALUES(updated_at)`,
    [CURRENT_EXHIBITION_ID, "当前展览", "active", null, null, now, now]
  );

  for (const booth of booths) {
    await execute(
      connection,
      `INSERT INTO exhibition_booths (
        id, exhibition_id, booth_number, company_name, company_short_name, sales_owner, builder,
        contact_name, contact_phone, raw_payload, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        company_name = VALUES(company_name),
        company_short_name = VALUES(company_short_name),
        sales_owner = VALUES(sales_owner),
        builder = VALUES(builder),
        enabled = true,
        updated_at = VALUES(updated_at)`,
      [
        stableId("booth", booth.boothNumber),
        CURRENT_EXHIBITION_ID,
        booth.boothNumber,
        booth.companyName,
        booth.companyShortName,
        booth.salesOwner,
        booth.builder,
        null,
        null,
        null,
        true,
        now,
        now
      ]
    );
  }
}

async function readRecentInboundMessages(connection: DatabaseConnection, limit = 50): Promise<InboundMessageRecord[]> {
  const messageRows = await rows<Row>(
    connection,
    `SELECT id, channel, external_message_id, sender_id, sender_name, sender_phone, sender_group,
      text, received_at, created_at, reporter_person_id, reporter_chat_identity_id,
      source_conversation_id, analysis_json
     FROM inbound_messages
     ORDER BY created_at DESC
     LIMIT ?`,
    [limit]
  );
  return messageRows.map((row) => ({
    id: String(row.id),
    channel: row.channel as InboundMessageRecord["channel"],
    externalMessageId: row.external_message_id ? String(row.external_message_id) : undefined,
    senderId: row.sender_id ? String(row.sender_id) : undefined,
    senderName: String(row.sender_name),
    senderPhone: row.sender_phone ? String(row.sender_phone) : undefined,
    senderGroup: row.sender_group ? String(row.sender_group) : undefined,
    text: String(row.text),
    imageUrls: [],
    receivedAt: requiredIso(row.received_at),
    createdAt: requiredIso(row.created_at),
    reporterPersonId: row.reporter_person_id ? String(row.reporter_person_id) : undefined,
    reporterChatIdentityId: row.reporter_chat_identity_id ? String(row.reporter_chat_identity_id) : undefined,
    sourceConversationId: row.source_conversation_id ? String(row.source_conversation_id) : undefined,
    analysis: parseJsonValue<InboundMessageRecord["analysis"]>(row.analysis_json, {
      confidence: 0,
      suggestedAction: "ignore",
      reason: ""
    })
  }));
}

async function readRecentOutboundMessages(connection: DatabaseConnection, limit = 50): Promise<OutboundMessage[]> {
  const messageRows = await rows<Row>(
    connection,
    "SELECT * FROM outbound_messages WHERE status <> 'sent' ORDER BY updated_at DESC LIMIT ?",
    [limit]
  );
  return messageRows.map(outboundMessageFromRow);
}

function outboundMessageFromRow(row: Row): OutboundMessage {
  return {
    id: String(row.id),
    channel: row.channel as OutboundMessage["channel"],
    targetConversationId: row.target_conversation_id ? String(row.target_conversation_id) : undefined,
    targetChatIdentityId: row.target_chat_identity_id ? String(row.target_chat_identity_id) : undefined,
    targetName: String(row.target_name),
    text: String(row.text),
    relatedTicketId: row.related_ticket_id ? String(row.related_ticket_id) : undefined,
    relatedSessionId: row.related_session_id ? String(row.related_session_id) : undefined,
    status: row.status as OutboundMessage["status"],
    retryCount: Number(row.retry_count ?? 0),
    lastError: row.last_error ? String(row.last_error) : undefined,
    claimedAt: iso(row.claimed_at),
    sentAt: iso(row.sent_at),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at)
  };
}

export type WechatOrderLog = {
  id: string;
  inboundMessageId?: string;
  channel: string;
  action: string;
  ticketId?: string;
  sessionId?: string;
  summary: string;
  status: string;
  createdAt: string;
};

export class MariaDbStateStore {
  async runAutoAcceptance(now?: Date): Promise<void>;
  async runAutoAcceptance(connection: DatabaseConnection, now?: Date): Promise<string[]>;
  async runAutoAcceptance(first?: Date | DatabaseConnection, second = new Date()): Promise<void | string[]> {
    if (!first || first instanceof Date) {
      const now = first ?? second;
      await withDatabaseTransaction(async (connection) => {
        await runAutoAcceptanceOnConnection(connection, now);
      });
      return;
    }
    return await runAutoAcceptanceOnConnection(first, second);
  }

  async mobileBootstrap(connection: DatabaseConnection = getDatabasePool()) {
    return {
      tickets: await readTicketSummaries(connection),
      config: await latestConfig(connection)
    };
  }

  async adminBootstrap(connection: DatabaseConnection = getDatabasePool()) {
    return {
      tickets: await readTicketSummaries(connection),
      booths: await readBooths(connection),
      messageRecords: await readRecentInboundMessages(connection),
      people: await readPeople(connection),
      chatIdentities: await readChatIdentities(connection),
      conversations: await readConversations(connection),
      pendingWorkOrderSessions: await readPendingSessions(connection),
      outboundMessages: await readRecentOutboundMessages(connection),
      config: await latestConfig(connection)
    };
  }

  async getConfig(connection: DatabaseConnection = getDatabasePool()) {
    return await latestConfig(connection);
  }

  async saveConfig(config: AppConfig) {
    await withDatabaseTransaction(async (connection) => {
      await replaceConfigTables(connection, config);
    });
    return config;
  }

  async saveKeywordGroups(keywordGroups: KeywordGroup[]) {
    const config = await latestConfig(getDatabasePool());
    const nextConfig = {
      ...config,
      keywordGroups: normalizeKeywordGroups(keywordGroups)
    };
    await this.saveConfig(nextConfig);
    return nextConfig.keywordGroups;
  }

  async importBooths(booths: BoothRecord[]) {
    await withDatabaseTransaction(async (connection) => {
      await upsertBoothRecords(connection, booths);
    });
    return await readBooths(getDatabasePool());
  }

  async listTicketSummaries(connection: DatabaseConnection = getDatabasePool()) {
    return await readTicketSummaries(connection);
  }

  async getTicket(ticketId: string, connection: DatabaseConnection = getDatabasePool()) {
    return await readTicketById(connection, ticketId);
  }

  async saveTicket(ticket: Ticket, options: { notificationText?: string } = {}) {
    await withDatabaseTransaction(async (connection) => {
      await upsertTicketGraph(connection, ticket);
      if (options.notificationText) {
        await queueTicketFeedbackOutbound(connection, ticket, options.notificationText);
      }
    });
    return ticket;
  }

  async submitTicket(input: SubmitTicketInput) {
    return await withDatabaseTransaction(async (connection) => {
      const state: AppState = {
        booths: await readBooths(connection),
        tickets: await readOpenTicketsForBooth(connection, input.boothNumber.trim()),
        messageRecords: [],
        people: [],
        chatIdentities: [],
        conversations: [],
        pendingWorkOrderSessions: [],
        outboundMessages: [],
        config: await latestConfig(connection)
      };
      const result = await createTicketService({ state }).submitTicket(input);
      await upsertTicketGraph(connection, result.ticket);
      return result;
    });
  }

  async processWechatMessage(input: IntakeMessageInput): Promise<WatchtowerResult> {
    return await withDatabaseTransaction(async (connection) => {
      const state = await this.readState(connection);
      const result = await processWechatWatchtowerMessage(state, input);
      await this.writeState(state, connection);
      return result;
    });
  }

  async claimOutboundMessages(limit = 10) {
    return await withDatabaseTransaction(async (connection) => {
      const now = new Date();
      const candidates = await rows<Row>(
        connection,
        `SELECT * FROM outbound_messages
         WHERE status = 'pending'
            OR (status = 'failed' AND retry_count < 3)
            OR (status = 'sending' AND claimed_at IS NOT NULL AND claimed_at <= ?)
         ORDER BY created_at
         LIMIT ?`,
        [new Date(now.getTime() - 120000), limit]
      );
      const messages = candidates.map((row) => ({
        id: String(row.id),
        channel: row.channel as OutboundMessage["channel"],
        targetConversationId: row.target_conversation_id ? String(row.target_conversation_id) : undefined,
        targetChatIdentityId: row.target_chat_identity_id ? String(row.target_chat_identity_id) : undefined,
        targetName: String(row.target_name),
        text: String(row.text),
        relatedTicketId: row.related_ticket_id ? String(row.related_ticket_id) : undefined,
        relatedSessionId: row.related_session_id ? String(row.related_session_id) : undefined,
        status: "sending" as const,
        retryCount: Number(row.retry_count ?? 0),
        lastError: row.last_error ? String(row.last_error) : undefined,
        claimedAt: now.toISOString(),
        sentAt: iso(row.sent_at),
        createdAt: requiredIso(row.created_at),
        updatedAt: now.toISOString()
      }));
      for (const message of messages) {
        await execute(
          connection,
          "UPDATE outbound_messages SET status = 'sending', claimed_at = ?, updated_at = ? WHERE id = ?",
          [now, now, message.id]
        );
      }
      return messages;
    });
  }

  async markOutboundMessage(messageId: string, status: "sent" | "failed", error?: string) {
    const now = new Date();
    const [existing] = await rows<Row>(getDatabasePool(), "SELECT * FROM outbound_messages WHERE id = ? LIMIT 1", [messageId]);
    if (!existing) return undefined;

    if (status === "sent") {
      await execute(
        getDatabasePool(),
        "UPDATE outbound_messages SET status = 'sent', sent_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
        [now, now, messageId]
      );
    } else {
      await execute(
        getDatabasePool(),
        "UPDATE outbound_messages SET status = 'failed', retry_count = retry_count + 1, last_error = ?, updated_at = ? WHERE id = ?",
        [error?.trim() || "发送失败", now, messageId]
      );
    }

    const [updated] = await rows<Row>(getDatabasePool(), "SELECT * FROM outbound_messages WHERE id = ? LIMIT 1", [messageId]);
    return updated ? outboundMessageFromRow(updated) : undefined;
  }

  async readState(connection: DatabaseConnection = getDatabasePool()): Promise<AppState> {
    return {
      booths: await readBooths(connection),
      tickets: await readTickets(connection),
      messageRecords: await readInboundMessages(connection),
      people: await readPeople(connection),
      chatIdentities: await readChatIdentities(connection),
      conversations: await readConversations(connection),
      pendingWorkOrderSessions: await readPendingSessions(connection),
      outboundMessages: await readOutboundMessages(connection),
      config: await latestConfig(connection)
    };
  }

  async writeState(state: AppState, connection?: DatabaseConnection) {
    const write = async (target: DatabaseConnection) => {
      const now = new Date();
      await clearStateTables(target);
      await writeConfig(target, state.config, now);
      await writeBooths(target, state.booths, now);
      await writePeople(target, state.people ?? [], now);
      await writeChatIdentities(target, state.chatIdentities ?? [], now);
      await writeConversations(target, state.conversations ?? [], now);
      await writeTickets(target, state.tickets, now);
      await writeInboundMessages(target, state.messageRecords, now);
      await writePendingSessions(target, state.pendingWorkOrderSessions ?? [], now);
      await writeOutboundMessages(target, state.outboundMessages ?? [], now);
    };

    if (connection) {
      await write(connection);
      return;
    }
    await withDatabaseTransaction(write);
  }

  async importState(state: AppState, sourceName = "data/app-state.json") {
    await withDatabaseTransaction(async (connection) => {
      await this.writeState(state, connection);
      const now = new Date();
      const jobId = stableId("import", `${sourceName}:${now.toISOString()}`);
      const totalRows = state.booths.length + state.tickets.length + state.messageRecords.length;
      await execute(
        connection,
        `INSERT INTO import_jobs (
          id, type, source_name, status, total_rows, success_rows, failed_rows, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [jobId, "app-state", sourceName, "completed", totalRows, totalRows, 0, now, now]
      );
      await execute(
        connection,
        `INSERT INTO import_job_rows (
          id, job_id, \`row_number\`, status, message, raw_payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [stableId("import-row", jobId), jobId, 1, "success", "Imported JSON state", json({ totalRows }), now]
      );
      await execute(
        connection,
        `INSERT INTO audit_logs (
          id, actor_id, actor_name, action, target_type, target_id, detail_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          stableId("audit", jobId),
          "system",
          "system",
          "import.app_state",
          "import_job",
          jobId,
          json({ sourceName, totalRows }),
          now
        ]
      );
    });
  }

  async listWechatOrderLogs(limit = 100, connection: DatabaseConnection = getDatabasePool()): Promise<WechatOrderLog[]> {
    const logRows = await rows<Row>(
      connection,
      "SELECT * FROM wechat_order_logs ORDER BY created_at DESC LIMIT ?",
      [limit]
    );
    return logRows.map((row) => ({
      id: String(row.id),
      inboundMessageId: row.inbound_message_id ? String(row.inbound_message_id) : undefined,
      channel: String(row.channel),
      action: String(row.action),
      ticketId: row.ticket_id ? String(row.ticket_id) : undefined,
      sessionId: row.session_id ? String(row.session_id) : undefined,
      summary: String(row.summary),
      status: String(row.status),
      createdAt: requiredIso(row.created_at)
    }));
  }
}

