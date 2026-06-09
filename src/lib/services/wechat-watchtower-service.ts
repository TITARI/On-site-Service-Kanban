import type { InboundMessageRecord, PendingWorkOrderField, PendingWorkOrderSession } from "../domain/types";
import type { AppState } from "../domain/app-state";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConfiguredAiProvider } from "../ai/provider";
import { createAiRouter } from "../ai/router";
import { ticketDetailUrl } from "../domain/ticket-links";
import type { CustomerServiceDecision, Ticket } from "../domain/types";
import { calculatePriorityScore, detectRiskWeight } from "../domain/priority";
import { elapsedSinceAccepted } from "../domain/workflow";
import { analyzeIntakeMessage, createMessageIntakeService, type IntakeMessageInput } from "./message-intake-service";
import { hasKeywordOperationalIntent, keywordGroupsForConfig } from "./keyword-service";
import { queueAdminMessage, queueOutboundMessage, queueProcessingGroupMessage, queueTicketFeedbackMessage } from "./outbound-message-service";
import {
  bindWechatIdentityFromRegistration,
  enabledIdentityGroups,
  ensureConversationAndIdentity,
  identityPromptText,
  missingIdentityFields,
  parseRegistrationCommand
} from "./wechat-identity-service";

export type WatchtowerAction = "ignored" | "prompted" | "registered" | "processed" | "duplicate";

export type WatchtowerResult = {
  action: WatchtowerAction;
  record?: InboundMessageRecord;
};

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizeText(value?: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function publicBaseUrlFromFile() {
  try {
    const filePath = join(process.cwd(), "data", "public-base-url.txt");
    if (!existsSync(filePath)) return undefined;
    return normalizeText(readFileSync(filePath, "utf8")) || undefined;
  } catch {
    return undefined;
  }
}

function configuredPublicBaseUrl() {
  return normalizeText(process.env.APP_PUBLIC_BASE_URL) || publicBaseUrlFromFile();
}

function creationReceiptText(ticket: { id: string; title: string; boothNumber: string; issueType: string; status: string }) {
  const detailUrl = ticketDetailUrl(ticket.id, configuredPublicBaseUrl());
  return [
    "现场工单已创建成功！",
    `名称：${ticket.title}`,
    `展位：${ticket.boothNumber}`,
    `类型：${ticket.issueType}`,
    `当前进度：${ticket.status}`,
    `工单详情：${detailUrl ?? ""}`
  ].join("\n");
}

function isOperationalText(text: string, imageUrls: string[] = []) {
  const normalized = normalizeText(text).toLowerCase();
  const keywords = [
    "报修",
    "故障",
    "处理",
    "需要",
    "不能",
    "无法",
    "没有",
    "坏",
    "断",
    "催",
    "加急",
    "尽快",
    "失败",
    "不亮",
    "漏水",
    "跳闸",
    "网络",
    "断网",
    "没电",
    "桌",
    "椅",
    "搭建",
    "电联",
    "电话",
    "联系",
    "联系不上",
    "联络",
    "打不通",
    "不通"
  ];
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase())) || (imageUrls.length > 0 && normalized.length > 0);
}

function messageTargetName(input: IntakeMessageInput) {
  return normalizeText(input.senderGroup) || normalizeText(input.senderName) || "微信会话";
}

function activeSessionFor(state: AppState, chatIdentityId: string) {
  return state.pendingWorkOrderSessions?.find((session) => session.chatIdentityId === chatIdentityId);
}

function isConfiguredOperationalText(state: AppState, text: string, imageUrls: string[] = []) {
  return hasKeywordOperationalIntent(normalizeText(text), imageUrls, keywordGroupsForConfig(state.config));
}

function createPromptSession(
  state: AppState,
  input: IntakeMessageInput,
  conversationId: string,
  chatIdentityId: string,
  missingFields: PendingWorkOrderField[],
  originalMessageRecordId?: string
) {
  state.pendingWorkOrderSessions ??= [];
  const timestamp = now();
  const existing = activeSessionFor(state, chatIdentityId);
  if (existing) {
    existing.conversationId = conversationId;
    existing.originalMessageRecordId = originalMessageRecordId ?? existing.originalMessageRecordId;
    existing.draftText = normalizeText(input.text) || existing.draftText;
    existing.draftImages = input.imageUrls ?? existing.draftImages;
    existing.missingFields = missingFields;
    existing.updatedAt = timestamp;
    existing.lastPromptAt = timestamp;
    return existing;
  }

  const session: PendingWorkOrderSession = {
    id: id("pending"),
    platform: input.channel,
    conversationId,
    chatIdentityId,
    originalMessageRecordId,
    draftText: normalizeText(input.text),
    draftImages: input.imageUrls ?? [],
    missingFields,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastPromptAt: timestamp
  };
  state.pendingWorkOrderSessions.push(session);
  return session;
}

function removeSession(state: AppState, sessionId: string) {
  state.pendingWorkOrderSessions = (state.pendingWorkOrderSessions ?? []).filter((session) => session.id !== sessionId);
}

function boothPromptText() {
  return "请补充展位号，例如：A01 网络断了，扫码收款失败";
}

function issuePromptText(state: AppState) {
  const issueTypes = state.config.issueTypes.filter((item) => item.enabled).map((item) => item.name).join("、");
  return `请补充问题类型。可选类型：${issueTypes}`;
}

function applyIdentityReplyToSession(state: AppState, session: PendingWorkOrderSession, text: string) {
  const normalized = normalizeText(text);
  const groups = enabledIdentityGroups(state);
  const group = groups.find((item) => normalized.includes(item));
  const phone = normalized.match(/1[3-9]\d{9}/)?.[0];

  let remaining = normalized
    .replace(/^(?:注册|绑定)\s*/, "")
    .replace(/[，,、;；:：]/g, " ");
  if (group) remaining = remaining.replace(group, " ");
  if (phone) remaining = remaining.replace(phone, " ");
  const name = remaining.replace(/\s+/g, " ").trim();

  if (group) session.identityGroup = group;
  if (phone) session.contactPhone = phone;
  if (name && !groups.includes(name)) session.contactName = name;

  session.missingFields = missingIdentityFields({
    identityGroup: session.identityGroup,
    name: session.contactName,
    phone: session.contactPhone
  });
  session.updatedAt = now();
  return session.missingFields;
}

function mergedSessionInput(input: IntakeMessageInput, session: PendingWorkOrderSession): IntakeMessageInput {
  const text = [session.draftText, input.text].map((item) => normalizeText(item)).filter(Boolean).join(" ");
  return {
    ...input,
    text,
    imageUrls: [...session.draftImages, ...(input.imageUrls ?? [])]
  };
}

function sessionDraftInput(input: IntakeMessageInput, session: PendingWorkOrderSession): IntakeMessageInput {
  return {
    ...input,
    text: session.draftText,
    imageUrls: session.draftImages
  };
}

async function recordRawMessage(state: AppState, input: IntakeMessageInput) {
  return createMessageIntakeService({ state }).recordMessage({ ...input, skipAutoCreate: true });
}

async function processCompleteRequest(state: AppState, input: IntakeMessageInput, personId?: string, chatIdentityId?: string, conversationId?: string) {
  const person = state.people?.find((item) => item.id === personId);
  const record = await createMessageIntakeService({ state }).recordMessage({
    ...input,
    senderName: person?.name ?? input.senderName,
    senderPhone: person?.phone ?? input.senderPhone,
    reporterPersonId: person?.id,
    reporterChatIdentityId: chatIdentityId,
    sourceConversationId: conversationId
  });

  if (record.analysis.matchedTicketId) {
    const ticket = state.tickets.find((item) => item.id === record.analysis.matchedTicketId);
    if (ticket) {
      const feedbackText = record.analysis.suggestedAction === "urge-existing"
        ? `已关联已有工单并催单：${ticket.title}\n当前催单次数：${ticket.urgeCount}`
        : creationReceiptText(ticket);
      queueTicketFeedbackMessage(state, ticket, feedbackText);
      if (record.analysis.suggestedAction === "create-ticket") {
        queueProcessingGroupMessage(state, ticket, `新工单：${ticket.title}\n${ticket.description}`);
      }
    }
  }

  return record;
}

function issueWeight(state: AppState, issueType: string) {
  return state.config.issueTypes.find((item) => item.name === issueType)?.priorityWeight ?? 0;
}

function openCustomerTickets(
  state: AppState,
  personId: string | undefined,
  chatIdentityId: string,
  conversationExternalId: string
) {
  const seen = new Set<string>();
  return state.tickets
    .filter((ticket) => ticket.status !== "已关闭")
    .filter((ticket) => (
      ticket.reporterPersonId === personId ||
      ticket.submitterId === personId ||
      ticket.reporterChatIdentityId === chatIdentityId ||
      ticket.sourceConversationId === conversationExternalId ||
      ticket.feedbackUsers.some((user) => user.userId === personId)
    ))
    .filter((ticket) => {
      if (seen.has(ticket.id)) return false;
      seen.add(ticket.id);
      return true;
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function customerMessageHistory(state: AppState, personId: string | undefined, chatIdentityId: string, conversationExternalId: string) {
  return (state.messageRecords ?? [])
    .filter((record) => (
      record.reporterPersonId === personId ||
      record.reporterChatIdentityId === chatIdentityId ||
      record.sourceConversationId === conversationExternalId
    ))
    .slice(-8)
    .map((record) => ({
      text: record.text,
      createdAt: record.createdAt,
      analysis: record.analysis
    }));
}

function canApplyCustomerExpedite(ticket: Ticket | undefined, decision: CustomerServiceDecision) {
  return Boolean(
    ticket &&
    ticket.status !== "已关闭" &&
    ticket.urgeLevel < 3 &&
    decision.action === "expedite" &&
    decision.confidence >= 0.85 &&
    decision.pressureLevel >= 4
  );
}

function applyCustomerServiceExpedite(
  state: AppState,
  ticket: Ticket,
  input: IntakeMessageInput,
  decision: CustomerServiceDecision,
  personId: string | undefined
) {
  const timestamp = now();
  ticket.urgeCount += 1;
  ticket.lastUrgedAt = timestamp;
  ticket.urgeLevel = Math.min(3, ticket.urgeLevel + 1) as Ticket["urgeLevel"];
  const submitterKey = personId ?? input.senderId ?? input.senderName ?? "wechat-user";
  const feedbackUser = ticket.feedbackUsers.find((user) => user.userId === submitterKey);
  if (feedbackUser) {
    feedbackUser.userName = normalizeText(input.senderName) || feedbackUser.userName;
    feedbackUser.feedbackAt = timestamp;
  } else {
    ticket.feedbackUsers.push({
      userId: submitterKey,
      userName: normalizeText(input.senderName) || ticket.submitterName,
      feedbackAt: timestamp
    });
  }
  ticket.priorityScore = calculatePriorityScore({
    issueWeight: issueWeight(state, ticket.issueType),
    riskWeight: detectRiskWeight(ticket.description),
    urgeCount: ticket.urgeCount,
    acceptedElapsedMinutes: elapsedSinceAccepted(ticket.acceptedAt, timestamp),
    urgeLevel: ticket.urgeLevel
  });
  ticket.aiDecisions.push({
    modelId: "smart",
    scenario: "customer-service",
    confidence: decision.confidence,
    action: "expedite",
    matchedTicketId: ticket.id,
    suggestion: `${decision.reason} 催办强度：${decision.pressureLevel}/5`,
    latencyMs: decision.latencyMs
  });
  ticket.timeline.push({
    id: id("timeline"),
    ticketId: ticket.id,
    type: "ai-suggestion",
    body: `AI判断客户催办强度较高，已自动加急。原因：${decision.reason}`,
    createdAt: timestamp,
    actorName: "系统AI"
  });
  ticket.updatedAt = timestamp;
}

async function tryProcessCustomerServiceExpedite(
  state: AppState,
  input: IntakeMessageInput,
  personId: string | undefined,
  chatIdentityId: string,
  conversationExternalId: string
): Promise<WatchtowerResult | undefined> {
  if (!personId) return undefined;
  const candidateTickets = openCustomerTickets(state, personId, chatIdentityId, conversationExternalId);
  if (candidateTickets.length === 0) return undefined;

  let decision: CustomerServiceDecision;
  try {
    const ai = createAiRouter({ models: state.config.aiModels, provider: createConfiguredAiProvider(), promptConfig: state.config });
    decision = await ai.customerService({
      messageText: normalizeText(input.text),
      senderName: normalizeText(input.senderName),
      historyMessages: customerMessageHistory(state, personId, chatIdentityId, conversationExternalId),
      candidateTickets
    });
  } catch {
    return undefined;
  }

  const matchedTicket = candidateTickets.find((ticket) => ticket.id === decision.matchedTicketId) ?? candidateTickets[0];
  if (!canApplyCustomerExpedite(matchedTicket, decision)) return undefined;

  const record = await recordRawMessage(state, input);
  record.analysis = {
    boothNumber: matchedTicket.boothNumber,
    issueType: matchedTicket.issueType,
    confidence: decision.confidence,
    suggestedAction: "urge-existing",
    matchedTicketId: matchedTicket.id,
    reason: decision.reason || "AI判断客户催办强度较高，已自动加急"
  };
  applyCustomerServiceExpedite(state, matchedTicket, input, decision, personId);
  queueTicketFeedbackMessage(state, matchedTicket, decision.replyText);
  queueProcessingGroupMessage(
    state,
    matchedTicket,
    `AI加急：${matchedTicket.title}\n用户反馈：${normalizeText(input.text)}\n催办强度：${decision.pressureLevel}/5\n原因：${decision.reason}`
  );
  queueAdminMessage(
    state,
    matchedTicket,
    `AI加急判断\n工单：${matchedTicket.title}\n当前进度：${matchedTicket.status}\n催办强度：${decision.pressureLevel}/5\n置信度：${Math.round(decision.confidence * 100)}%\n原因：${decision.reason}\n系统动作：已自动加急并通知处理组`
  );
  return { action: "processed", record };
}

function queuePrompt(
  state: AppState,
  input: IntakeMessageInput,
  conversationExternalId: string,
  chatIdentityId: string,
  text: string,
  relatedSessionId?: string
) {
  queueOutboundMessage(state, {
    channel: input.channel,
    targetConversationId: conversationExternalId,
    targetChatIdentityId: chatIdentityId,
    targetName: messageTargetName(input),
    text,
    relatedSessionId
  });
}

async function continueSession(
  state: AppState,
  input: IntakeMessageInput,
  session: PendingWorkOrderSession,
  personId: string | undefined,
  chatIdentityId: string,
  conversationId: string,
  conversationExternalId: string
): Promise<WatchtowerResult> {
  if (session.missingFields.some((field) => ["identityGroup", "name", "phone"].includes(field))) {
    const missingFields = applyIdentityReplyToSession(state, session, input.text ?? "");
    if (missingFields.length > 0) {
      session.lastPromptAt = now();
      const record = await recordRawMessage(state, input);
      queuePrompt(state, input, conversationExternalId, chatIdentityId, identityPromptText(missingFields, enabledIdentityGroups(state)), session.id);
      return { action: "prompted", record };
    }

    let person;
    try {
      person = bindWechatIdentityFromRegistration(state, chatIdentityId, {
        identityGroup: session.identityGroup ?? "",
        name: session.contactName ?? "",
        phone: session.contactPhone ?? ""
      });
    } catch (error) {
      return promptRegistrationError(state, input, session, conversationExternalId, chatIdentityId, error);
    }
    session.personId = person.id;
    queuePrompt(state, input, conversationExternalId, chatIdentityId, `${person.name}已注册并绑定：${person.groupName} ${person.phone}`, session.id);
    return continueSessionAfterRegistration(state, input, session, person.id, chatIdentityId, conversationId, conversationExternalId);
  }

  const mergedInput = mergedSessionInput(input, session);
  const analysis = await analyzeIntakeMessage(state, mergedInput);
  if (!analysis.boothNumber) {
    const record = await recordRawMessage(state, input);
    const promptSession = createPromptSession(state, mergedInput, conversationId, chatIdentityId, ["boothNumber"], session.originalMessageRecordId ?? record.id);
    queuePrompt(state, input, conversationExternalId, chatIdentityId, boothPromptText(), promptSession.id);
    return { action: "prompted", record };
  }

  if (!analysis.issueType) {
    const record = await recordRawMessage(state, input);
    const promptSession = createPromptSession(state, mergedInput, conversationId, chatIdentityId, ["issueType"], session.originalMessageRecordId ?? record.id);
    queuePrompt(state, input, conversationExternalId, chatIdentityId, issuePromptText(state), promptSession.id);
    return { action: "prompted", record };
  }

  removeSession(state, session.id);
  const record = await processCompleteRequest(state, mergedInput, personId, chatIdentityId, conversationExternalId);
  return { action: "processed", record };
}

async function continueSessionAfterRegistration(
  state: AppState,
  input: IntakeMessageInput,
  session: PendingWorkOrderSession,
  personId: string,
  chatIdentityId: string,
  conversationId: string,
  conversationExternalId: string
): Promise<WatchtowerResult> {
  const originalInput = sessionDraftInput(input, session);
  const analysis = await analyzeIntakeMessage(state, originalInput);

  if (!analysis.boothNumber) {
    const record = await recordRawMessage(state, originalInput);
    const promptSession = createPromptSession(state, originalInput, conversationId, chatIdentityId, ["boothNumber"], session.originalMessageRecordId ?? record.id);
    promptSession.personId = personId;
    queuePrompt(state, input, conversationExternalId, chatIdentityId, boothPromptText(), promptSession.id);
    return { action: "prompted", record };
  }

  if (!analysis.issueType) {
    const record = await recordRawMessage(state, originalInput);
    const promptSession = createPromptSession(state, originalInput, conversationId, chatIdentityId, ["issueType"], session.originalMessageRecordId ?? record.id);
    promptSession.personId = personId;
    queuePrompt(state, input, conversationExternalId, chatIdentityId, issuePromptText(state), promptSession.id);
    return { action: "prompted", record };
  }

  removeSession(state, session.id);
  const record = await processCompleteRequest(state, originalInput, personId, chatIdentityId, conversationExternalId);
  return { action: "processed", record };
}

export async function processWechatWatchtowerMessage(state: AppState, input: IntakeMessageInput): Promise<WatchtowerResult> {
  state.messageRecords ??= [];
  if (input.externalMessageId && state.messageRecords.some((record) => record.channel === input.channel && record.externalMessageId === input.externalMessageId)) {
    return { action: "duplicate" };
  }

  const { conversation, identity } = ensureConversationAndIdentity(state, {
    channel: input.channel,
    senderId: input.senderId,
    senderName: input.senderName,
    senderGroup: input.senderGroup,
    sourceConversationId: input.sourceConversationId
  });
  const session = activeSessionFor(state, identity.id);
  const registration = parseRegistrationCommand(input.text ?? "");

  if (registration) {
    try {
      const person = bindWechatIdentityFromRegistration(state, identity.id, registration);
      queuePrompt(
        state,
        input,
        conversation.externalConversationId,
        identity.id,
        `${person.name}已注册并绑定：${person.groupName} ${person.phone}`,
        session?.id
      );

      if (session) {
        return continueSessionAfterRegistration(state, input, session, person.id, identity.id, conversation.id, conversation.externalConversationId);
      }

      const record = await recordRawMessage(state, input);
      return { action: "registered", record };
    } catch (error) {
      const promptSession = session ?? createPromptSession(state, input, conversation.id, identity.id, ["identityGroup", "name", "phone"]);
      return promptRegistrationError(state, input, promptSession, conversation.externalConversationId, identity.id, error);
    }
  }

  const identityPerson = identity.personId ? state.people?.find((person) => person.id === identity.personId) : undefined;
  if (session) {
    return continueSession(
      state,
      input,
      session,
      identityPerson?.id,
      identity.id,
      conversation.id,
      conversation.externalConversationId
    );
  }

  const imageUrls = input.imageUrls ?? [];
  const analysis = await analyzeIntakeMessage(state, input);
  const operational = isConfiguredOperationalText(state, input.text ?? "", imageUrls) || analysis.suggestedAction !== "ignore";

  if (!identityPerson && operational) {
    const record = await recordRawMessage(state, input);
    const promptSession = createPromptSession(state, input, conversation.id, identity.id, ["identityGroup", "name", "phone"], record.id);
    queuePrompt(
      state,
      input,
      conversation.externalConversationId,
      identity.id,
      identityPromptText(promptSession.missingFields, enabledIdentityGroups(state)),
      promptSession.id
    );
    return { action: "prompted", record };
  }

  if (!operational) {
    const record = await recordRawMessage(state, input);
    return { action: "ignored", record };
  }

  const customerServiceResult = await tryProcessCustomerServiceExpedite(
    state,
    input,
    identityPerson?.id,
    identity.id,
    conversation.externalConversationId
  );
  if (customerServiceResult) return customerServiceResult;

  if (!analysis.boothNumber) {
    const record = await recordRawMessage(state, input);
    const promptSession = createPromptSession(state, input, conversation.id, identity.id, ["boothNumber"], record.id);
    queuePrompt(state, input, conversation.externalConversationId, identity.id, boothPromptText(), promptSession.id);
    return { action: "prompted", record };
  }

  if (!analysis.issueType) {
    const record = await recordRawMessage(state, input);
    const promptSession = createPromptSession(state, input, conversation.id, identity.id, ["issueType"], record.id);
    queuePrompt(state, input, conversation.externalConversationId, identity.id, issuePromptText(state), promptSession.id);
    return { action: "prompted", record };
  }

  const record = await processCompleteRequest(state, input, identityPerson?.id, identity.id, conversation.externalConversationId);
  return { action: "processed", record };
}

async function promptRegistrationError(
  state: AppState,
  input: IntakeMessageInput,
  session: PendingWorkOrderSession,
  conversationExternalId: string,
  chatIdentityId: string,
  error: unknown
): Promise<WatchtowerResult> {
  const message = error instanceof Error ? error.message : "注册信息有误";
  session.missingFields = ["identityGroup", "name", "phone"];
  session.lastPromptAt = now();
  queuePrompt(
    state,
    input,
    conversationExternalId,
    chatIdentityId,
    `${message}。${identityPromptText(["identityGroup", "name", "phone"], enabledIdentityGroups(state))}`,
    session.id
  );
  const record = await recordRawMessage(state, input);
  return { action: "prompted", record };
}

