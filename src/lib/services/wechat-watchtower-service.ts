import type { InboundMessageRecord, PendingWorkOrderField, PendingWorkOrderSession } from "../domain/types";
import type { AppState } from "../domain/app-state";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConfiguredAiProvider } from "../ai/provider";
import { createAiRouter } from "../ai/router";
import { ticketDetailUrl, ticketShortCode } from "../domain/ticket-links";
import type { CustomerServiceDecision, Ticket, TicketStatus } from "../domain/types";
import { calculatePriorityScore, detectRiskWeight } from "../domain/priority";
import { canTransition, elapsedSinceAccepted } from "../domain/workflow";
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

export type WatchtowerAction = "ignored" | "prompted" | "registered" | "processed" | "duplicate" | "error";

export type WatchtowerResult = {
  action: WatchtowerAction;
  record?: InboundMessageRecord;
  replyText?: string;
};

const MEDIA_FOLLOWUP_WINDOW_MS = 2 * 60 * 1000;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const HANDLER_COMPLETION_KEYWORDS = [
  "已处理",
  "处理好了",
  "处理完成",
  "已完成",
  "完成",
  "修好了",
  "修复",
  "已修复",
  "已解决",
  "解决了",
  "好了",
  "搞定",
  "完工",
  "测试正常",
  "恢复正常"
];
const NEGATION_PREFIXES = ["未", "没", "不", "非", "无"];
const FAILURE_CONTEXT_KEYWORDS = ["失败", "不行", "未果", "不够", "没有", "不能"];
const HANDLER_PROGRESS_KEYWORDS = [
  "处理",
  "维修",
  "更换",
  "调整",
  "加固",
  "测试",
  "排查",
  "到场",
  "已到",
  "施工",
  "照片",
  "已补"
];
function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizeText(value?: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function imageUrlsOf(input: IntakeMessageInput) {
  return input.imageUrls ?? [];
}

function mergeImageUrls(existing: string[], incoming: string[]) {
  return Array.from(new Set([...existing, ...incoming.map((item) => item.trim()).filter(Boolean)]));
}

function mergeDraftText(existing: string, incoming?: string) {
  const current = normalizeText(existing);
  const next = normalizeText(incoming);
  if (!next) return current;
  if (!current) return next;
  if (current.includes(next)) return current;
  if (next.includes(current)) return next;
  return `${current} ${next}`;
}

function isImageOnlyInput(input: IntakeMessageInput) {
  return imageUrlsOf(input).length > 0 && !normalizeText(input.text);
}

function inputTimestampMs(input: IntakeMessageInput) {
  const timestamp = normalizeText(input.receivedAt);
  const parsed = timestamp ? new Date(timestamp).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isWithinMediaWindow(referenceIso: string | undefined, input: IntakeMessageInput) {
  if (!referenceIso) return false;
  const referenceMs = new Date(referenceIso).getTime();
  if (!Number.isFinite(referenceMs)) return false;
  return Math.abs(inputTimestampMs(input) - referenceMs) <= MEDIA_FOLLOWUP_WINDOW_MS;
}

function looksLikeBoothReference(text: string) {
  return /(?:展位|展台|摊位|booth)?\s*((?:\d+[A-Za-z]{1,4}|[A-Za-z]{1,4})[-\s]?\d{1,5}[A-Za-z]?)/i.test(text);
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

function isIdentityRegistrationSession(session: PendingWorkOrderSession) {
  return session.missingFields.some((field) => ["identityGroup", "name", "phone"].includes(field));
}

function isHandlerReplySession(session: PendingWorkOrderSession) {
  return session.sessionKind === "handler-reply";
}

function markHandlerReplySession(session: PendingWorkOrderSession) {
  session.sessionKind = "handler-reply";
}

function isOperatorInitiatedInput(input: IntakeMessageInput) {
  return input.operatorInitiated === true || input.raw?.operatorInitiated === true;
}

function isConfiguredOperationalText(state: AppState, text: string, imageUrls: string[] = []) {
  return hasKeywordOperationalIntent(normalizeText(text), imageUrls, keywordGroupsForConfig(state.config));
}

function shouldAccumulateWorkOrderDraft(state: AppState, input: IntakeMessageInput) {
  const text = normalizeText(input.text);
  const imageUrls = imageUrlsOf(input);
  if (imageUrls.length > 0) return true;
  if (!text) return false;
  return isConfiguredOperationalText(state, text, imageUrls) || looksLikeBoothReference(text);
}

function accumulateWorkOrderDraft(state: AppState, session: PendingWorkOrderSession, input: IntakeMessageInput) {
  if (!shouldAccumulateWorkOrderDraft(state, input)) return;
  session.draftText = mergeDraftText(session.draftText, input.text);
  session.draftImages = mergeImageUrls(session.draftImages, imageUrlsOf(input));
  session.updatedAt = now();
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
    existing.draftImages = mergeImageUrls(existing.draftImages, imageUrlsOf(input));
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
    draftImages: mergeImageUrls([], imageUrlsOf(input)),
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

function cleanupExpiredSessions(state: AppState, currentTime = Date.now()): number {
  const expired = (state.pendingWorkOrderSessions ?? []).filter((session) => {
    if (!session.lastPromptAt) return false;
    return currentTime - new Date(session.lastPromptAt).getTime() > SESSION_TIMEOUT_MS;
  });

  for (const session of expired) {
    const age = currentTime - new Date(session.lastPromptAt!).getTime();
    console.info("[watchtower] session 过期，移除", {
      sessionId: session.id,
      chatIdentityId: session.chatIdentityId,
      conversationId: session.conversationId,
      lastPromptAt: session.lastPromptAt,
      age
    });
    removeSession(state, session.id);
  }
  return expired.length;
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
    imageUrls: mergeImageUrls(session.draftImages, imageUrlsOf(input))
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
    provider: decision.provider,
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

function isHandlerPerson(state: AppState, person: NonNullable<AppState["people"]>[number] | undefined) {
  if (!person?.enabled) return false;
  if (person.role === "handler") return true;
  const group = state.config.userGroups?.find((item) => item.enabled && item.name === person.groupName);
  return Boolean(group?.canClaim || group?.canProcess);
}

function handlerTextIncludes(text: string, keywords: string[]) {
  const normalized = normalizeText(text);
  return keywords.some((keyword) => normalized.includes(keyword));
}

function hasNegationBefore(text: string, matchIndex: number): boolean {
  const start = Math.max(0, matchIndex - 3);
  const prefix = text.slice(start, matchIndex);
  return NEGATION_PREFIXES.some((negation) => prefix.includes(negation));
}

function hasFailureContextAfter(text: string, matchIndex: number, keyword: string): boolean {
  const after = text.slice(matchIndex + keyword.length, matchIndex + keyword.length + 4);
  return FAILURE_CONTEXT_KEYWORDS.some((keyword) => after.includes(keyword));
}

export function isHandlerCompletionText(text: string): boolean {
  const normalized = normalizeText(text);
  for (const keyword of HANDLER_COMPLETION_KEYWORDS) {
    let searchFrom = 0;
    while (true) {
      const matchIndex = normalized.indexOf(keyword, searchFrom);
      if (matchIndex === -1) break;
      if (!hasNegationBefore(normalized, matchIndex) && !hasFailureContextAfter(normalized, matchIndex, keyword)) {
        return true;
      }
      searchFrom = matchIndex + keyword.length;
    }
  }
  return false;
}

function hasHandlerProgressSignal(text: string, imageUrls: string[]) {
  if (imageUrls.length > 0) return true;
  if (isHandlerCompletionText(text)) return true;
  return looksLikeBoothReference(text) && handlerTextIncludes(text, HANDLER_PROGRESS_KEYWORDS);
}

function ticketAssignedToHandler(ticket: Ticket, person: NonNullable<AppState["people"]>[number]) {
  return Boolean(
    ticket.handlerId === person.id ||
    ticket.handlerPhone === person.phone ||
    ticket.handlerName === person.name ||
    ticket.assignmentGroup === person.groupName
  );
}

function handlerCandidateTickets(
  state: AppState,
  person: NonNullable<AppState["people"]>[number],
  analysis: { boothNumber?: string }
) {
  const matches = state.tickets
    .filter((ticket) => ticketAssignedToHandler(ticket, person))
    .filter((ticket) => !analysis.boothNumber || ticket.boothNumber === analysis.boothNumber)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const openTickets = matches.filter((ticket) => ticket.status !== "已关闭");
  return openTickets.length > 0 ? openTickets : matches;
}

function handlerPromptText() {
  return "已收到处理反馈，请补充展位号或工单短链，例如：A01 已处理完成";
}

function handlerReplyBody(input: IntakeMessageInput) {
  return normalizeText(input.text) || "现场已补充处理照片";
}

function applyHandlerReplyToTicket(
  state: AppState,
  ticket: Ticket,
  input: IntakeMessageInput,
  person: NonNullable<AppState["people"]>[number]
) {
  const timestamp = now();
  const body = handlerReplyBody(input);
  const imageUrls = imageUrlsOf(input);
  const wantsResolve = isHandlerCompletionText(body);
  const previousStatus = ticket.status;

  ticket.handlerId = ticket.handlerId ?? person.id;
  ticket.handlerName = ticket.handlerName ?? person.name;
  ticket.handlerPhone = ticket.handlerPhone ?? person.phone;
  ticket.assignmentGroup = ticket.assignmentGroup ?? person.groupName;
  ticket.acceptedAt = ticket.acceptedAt ?? timestamp;
  ticket.replies.push({
    id: id("reply"),
    ticketId: ticket.id,
    authorId: person.id,
    authorName: person.name,
    authorPhone: person.phone,
    role: "handler",
    body,
    imageUrls,
    createdAt: timestamp
  });

  let nextStatus: TicketStatus | undefined;
  let timelineBody: string;

  if (wantsResolve) {
    if (previousStatus === "待受理" || previousStatus === "待再次处理") {
      nextStatus = canTransition(previousStatus, "处理中") ? "处理中" : undefined;
      timelineBody = `处理人员反馈：${body}（工单已转入处理中）`;
    } else if (canTransition(previousStatus, "已解决")) {
      nextStatus = "已解决";
      timelineBody = `状态变更为已解决：${body}`;
    } else {
      timelineBody = `处理人员反馈：${body}`;
    }
  } else if (ticket.status === "待受理" || ticket.status === "挂起") {
    nextStatus = canTransition(previousStatus, "处理中") ? "处理中" : undefined;
    timelineBody = `处理进度：${body}`;
  } else {
    timelineBody = `处理进度：${body}`;
  }

  if (nextStatus && nextStatus !== previousStatus) {
    ticket.status = nextStatus;
  }

  ticket.timeline.push({
    id: id("timeline"),
    ticketId: ticket.id,
    type: nextStatus && nextStatus !== previousStatus ? "status-changed" : "reply",
    body: timelineBody,
    createdAt: timestamp,
    actorName: person.name,
    toStatus: nextStatus
  });
  ticket.updatedAt = timestamp;

  if (nextStatus === "已解决" && previousStatus !== "已解决") {
    queueTicketFeedbackMessage(state, ticket, `工单已解决：${ticket.title}\n处理说明：${body}`);
  }
}

async function tryProcessHandlerReply(
  state: AppState,
  input: IntakeMessageInput,
  person: NonNullable<AppState["people"]>[number],
  chatIdentityId: string,
  conversationId: string,
  conversationExternalId: string,
  session?: PendingWorkOrderSession
): Promise<WatchtowerResult | undefined> {
  const mergedInput = session ? mergedSessionInput(input, session) : input;
  const text = normalizeText(mergedInput.text);
  const imageUrls = imageUrlsOf(mergedInput);
  if (!session && !hasHandlerProgressSignal(text, imageUrls)) return undefined;

  const analysis = await analyzeIntakeMessage(state, mergedInput);
  const candidates = handlerCandidateTickets(state, person, analysis);
  if (candidates.length !== 1) {
    if (!session && isImageOnlyInput(input)) return undefined;
    const record = await recordRawMessage(state, input);
    record.analysis = {
      boothNumber: analysis.boothNumber,
      issueType: analysis.issueType,
      confidence: analysis.confidence,
      suggestedAction: "needs-review",
      reason: candidates.length > 1 ? "处理人员反馈匹配到多个工单，需要补充展位或工单信息" : "处理人员反馈未匹配到负责的未关闭工单"
    };
    const promptSession = createPromptSession(state, mergedInput, conversationId, chatIdentityId, ["boothNumber"], session?.originalMessageRecordId ?? record.id);
    promptSession.personId = person.id;
    markHandlerReplySession(promptSession);
    queuePrompt(state, input, conversationExternalId, chatIdentityId, handlerPromptText(), promptSession.id);
    return { action: "prompted", record };
  }

  const ticket = candidates[0];
  const record = await recordRawMessage(state, input);
  record.analysis = {
    boothNumber: ticket.boothNumber,
    issueType: ticket.issueType,
    confidence: Math.max(0.8, analysis.confidence),
    suggestedAction: "needs-review",
    matchedTicketId: ticket.id,
    reason: isHandlerCompletionText(text) ? "识别到处理人员完成反馈，已追加到工单" : "识别到处理人员进度反馈，已追加到工单"
  };
  if (session) removeSession(state, session.id);
  applyHandlerReplyToTicket(state, ticket, mergedInput, person);
  return { action: "processed", record };
}

function reporterTicketMatches(
  ticket: Ticket,
  personId: string | undefined,
  chatIdentityId: string,
  conversationExternalId: string
) {
  return Boolean(
    ticket.reporterPersonId === personId ||
    ticket.submitterId === personId ||
    ticket.reporterChatIdentityId === chatIdentityId ||
    ticket.sourceConversationId === conversationExternalId
  );
}

function recentReporterTicketsForImages(
  state: AppState,
  input: IntakeMessageInput,
  personId: string | undefined,
  chatIdentityId: string,
  conversationExternalId: string
) {
  return state.tickets
    .filter((ticket) => ticket.status !== "已关闭")
    .filter((ticket) => reporterTicketMatches(ticket, personId, chatIdentityId, conversationExternalId))
    .filter((ticket) => (
      isWithinMediaWindow(ticket.createdAt, input) ||
      isWithinMediaWindow(ticket.updatedAt, input) ||
      (state.messageRecords ?? []).some((record) => (
        record.analysis.matchedTicketId === ticket.id &&
        (isWithinMediaWindow(record.receivedAt, input) || isWithinMediaWindow(record.createdAt, input))
      ))
    ))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function imageFollowupPromptText() {
  return "已收到图片，请补充展位号和具体问题，例如：A01 网络断了";
}

function attachReporterImagesToTicket(ticket: Ticket, input: IntakeMessageInput, actorName: string) {
  const timestamp = now();
  ticket.imageUrls = mergeImageUrls(ticket.imageUrls, imageUrlsOf(input));
  ticket.timeline.push({
    id: id("timeline"),
    ticketId: ticket.id,
    type: "reply",
    body: "微信补充现场图片",
    createdAt: timestamp,
    actorName
  });
  ticket.updatedAt = timestamp;
}

async function processImageOnlyWorkOrderMessage(
  state: AppState,
  input: IntakeMessageInput,
  personId: string | undefined,
  chatIdentityId: string,
  conversationId: string,
  conversationExternalId: string,
  operatorInitiated: boolean
): Promise<WatchtowerResult | undefined> {
  if (!isImageOnlyInput(input)) return undefined;

  const candidates = recentReporterTicketsForImages(state, input, personId, chatIdentityId, conversationExternalId);
  if (candidates.length === 1) {
    const recentTicket = candidates[0];
    const record = await recordRawMessage(state, input);
    record.analysis = {
      boothNumber: recentTicket.boothNumber,
      issueType: recentTicket.issueType,
      confidence: 0.85,
      suggestedAction: "needs-review",
      matchedTicketId: recentTicket.id,
      reason: "同一微信会话短时间内补充图片，已归入刚创建或刚更新的工单"
    };
    attachReporterImagesToTicket(recentTicket, input, normalizeText(input.senderName) || "微信用户");
    return { action: "processed", record };
  }

  const record = await recordRawMessage(state, input);
  const needsIdentity = !personId && !operatorInitiated;
  const missingFields: PendingWorkOrderField[] = needsIdentity ? ["identityGroup", "name", "phone"] : ["boothNumber"];
  const promptSession = createPromptSession(state, input, conversationId, chatIdentityId, missingFields, record.id);
  if (personId) promptSession.personId = personId;
  let promptText: string;
  if (needsIdentity) {
    promptText = `已收到图片。${identityPromptText(missingFields, enabledIdentityGroups(state))}`;
  } else if (candidates.length > 1) {
    const ticketList = candidates
      .slice(0, 5)
      .map((ticket, index) => `${index + 1}. ${ticketShortCode(ticket.id)} - ${ticket.boothNumber} - ${ticket.issueType}`)
      .join("\n");
    promptText = `已收到图片，您近期有多张工单，请回复对应工单短链或展位号：\n${ticketList}`;
  } else {
    promptText = imageFollowupPromptText();
  }
  queuePrompt(state, input, conversationExternalId, chatIdentityId, promptText, promptSession.id);
  return { action: "prompted", record };
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
      accumulateWorkOrderDraft(state, session, input);
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

  try {
    const record = await processCompleteRequest(state, originalInput, personId, chatIdentityId, conversationExternalId);
    removeSession(state, session.id);
    return { action: "processed", record };
  } catch (error) {
    console.warn("[watchtower] processCompleteRequest 失败，session 保留", {
      sessionId: session.id,
      chatIdentityId: session.chatIdentityId,
      conversationId: session.conversationId,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    });
    return {
      action: "error",
      replyText: "您的诉求处理遇到问题，已记录待人工跟进，请稍后再试或联系现场管理员。"
    };
  }
}

export async function processWechatWatchtowerMessage(state: AppState, input: IntakeMessageInput): Promise<WatchtowerResult> {
  const expiredCount = cleanupExpiredSessions(state);
  if (expiredCount > 0) {
    console.info("[watchtower] 清理过期 session", { count: expiredCount });
  }

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
  const operatorInitiated = isOperatorInitiatedInput(input);

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
  const activeSession = operatorInitiated && session && isIdentityRegistrationSession(session) ? undefined : session;
  if (session && !activeSession) {
    removeSession(state, session.id);
  }
  if (identityPerson && isHandlerPerson(state, identityPerson)) {
    const handlerSession = activeSession
      && !isIdentityRegistrationSession(activeSession)
      && (isHandlerReplySession(activeSession) || hasHandlerProgressSignal(input.text ?? "", imageUrlsOf(input)))
      ? activeSession
      : undefined;
    const handlerResult = await tryProcessHandlerReply(
      state,
      input,
      identityPerson,
      identity.id,
      conversation.id,
      conversation.externalConversationId,
      handlerSession
    );
    if (handlerResult) return handlerResult;
  }
  if (activeSession) {
    return continueSession(
      state,
      input,
      activeSession,
      identityPerson?.id,
      identity.id,
      conversation.id,
      conversation.externalConversationId
    );
  }

  const imageUrls = input.imageUrls ?? [];
  const imageOnlyResult = await processImageOnlyWorkOrderMessage(
    state,
    input,
    identityPerson?.id,
    identity.id,
    conversation.id,
    conversation.externalConversationId,
    operatorInitiated
  );
  if (imageOnlyResult) return imageOnlyResult;

  const analysis = await analyzeIntakeMessage(state, input);
  const operational = isConfiguredOperationalText(state, input.text ?? "", imageUrls) || analysis.suggestedAction !== "ignore";

  if (!identityPerson && operational && !operatorInitiated) {
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

