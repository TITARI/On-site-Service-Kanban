import { createConfiguredAiProvider } from "../ai/provider";
import { createAiRouter } from "../ai/router";
import type { InboundMessageRecord, IssueType, MessageChannel, MessageTicketAnalysis, Ticket } from "../domain/types";
import { createTicketService } from "./ticket-service";
import type { AppState } from "../domain/app-state";
import { detectKeywordIssueType, hasKeywordOperationalIntent, keywordGroupsForConfig } from "./keyword-service";

export type IntakeMessageInput = {
  channel: MessageChannel;
  externalMessageId?: string;
  senderId?: string;
  senderName?: string;
  senderPhone?: string;
  senderGroup?: string;
  text?: string;
  imageUrls?: string[];
  receivedAt?: string;
  reporterPersonId?: string;
  reporterChatIdentityId?: string;
  sourceConversationId?: string;
  raw?: Record<string, unknown>;
  skipAutoCreate?: boolean;
  operatorInitiated?: boolean;
};

const CLOSED_STATUS = "已关闭";
const AUTO_ISSUE_TYPE_NAME = "自动";

const issueKeywordMap: Array<{ issue: string; keywords: string[] }> = [
  { issue: "综合服务", keywords: ["电联", "电话", "联系", "联系不上", "联络", "打不通", "不通"] },
  { issue: "网络", keywords: ["网络", "断网", "网线", "wifi", "wi-fi", "扫码", "收款"] },
  { issue: "电力", keywords: ["电力", "没电", "断电", "电源", "接电", "用电", "电箱", "插座", "跳闸", "照明", "不亮", "灯"] },
  { issue: "搭建", keywords: ["搭建", "门头", "背板", "地毯", "展板", "结构", "施工"] },
  { issue: "综合服务", keywords: ["桌", "椅", "物料", "租赁", "会刊", "证件", "服务"] }
];

const operationalKeywords = [
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
  "电联",
  "电话",
  "联系",
  "联系不上",
  "联络",
  "打不通",
  "不通"
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

function enabledIssueTypes(state: AppState) {
  return state.config.issueTypes.filter((item) => item.enabled && item.id !== "auto" && item.name !== AUTO_ISSUE_TYPE_NAME);
}

function extractBoothNumber(state: AppState, text: string) {
  const normalizedText = text.toUpperCase();
  const knownBooth = [...state.booths]
    .sort((a, b) => b.boothNumber.length - a.boothNumber.length)
    .find((booth) => normalizedText.includes(booth.boothNumber.toUpperCase()));
  if (knownBooth) return knownBooth.boothNumber;

  const match = text.match(/(?:展位|展台|摊位|booth)?\s*((?:\d+[A-Za-z]{1,4}|[A-Za-z]{1,4})[-\s]?\d{1,5}[A-Za-z]?)/i);
  return match?.[1]?.replace(/\s+/g, "").toUpperCase();
}

function textIncludesAny(text: string, keywords: string[]) {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function hasOperationalIntent(state: AppState, text: string, imageUrls: string[]) {
  return hasKeywordOperationalIntent(text, imageUrls, keywordGroupsForConfig(state.config));
}

function exactIssueType(text: string, issueTypes: IssueType[]) {
  return issueTypes.find((item) => text.includes(item.name))?.name;
}

function keywordIssueType(state: AppState, text: string, issueTypes: IssueType[]) {
  return detectKeywordIssueType(text, issueTypes, keywordGroupsForConfig(state.config));
}

function fallbackIssueType(state: AppState) {
  return enabledIssueTypes(state).find((item) => item.name === "综合服务")?.name;
}

function openTickets(state: AppState, boothNumber: string) {
  return state.tickets.filter((ticket) => ticket.boothNumber === boothNumber && ticket.status !== CLOSED_STATUS);
}

function bestSameIssueTicket(candidates: Ticket[], issueType?: string) {
  if (!issueType) return candidates[0];
  return candidates.find((ticket) => ticket.issueType === issueType) ?? candidates[0];
}

function integrationFor(state: AppState, channel: MessageChannel) {
  return state.config.messageIntegrations?.find((item) => item.channel === channel);
}

async function inferIssueType(state: AppState, boothNumber: string | undefined, text: string) {
  const issueTypes = enabledIssueTypes(state);
  const localIssueType = exactIssueType(text, issueTypes) ?? keywordIssueType(state, text, issueTypes);
  if (localIssueType) return { issueType: localIssueType, confidence: 0.82 };
  if (!boothNumber || !text) return { issueType: undefined, confidence: 0.35 };

  try {
    const ai = createAiRouter({ models: state.config.aiModels, provider: createConfiguredAiProvider(), promptConfig: state.config });
    const decision = await ai.classifyIssue(boothNumber, text);
    return { issueType: decision.issueType, confidence: decision.confidence };
  } catch {
    return { issueType: undefined, confidence: 0.35 };
  }
}

export async function analyzeIntakeMessage(state: AppState, input: Required<Pick<IntakeMessageInput, "channel">> & IntakeMessageInput): Promise<MessageTicketAnalysis> {
  const text = normalizeText(input.text);
  const imageUrls = input.imageUrls ?? [];
  const boothNumber = extractBoothNumber(state, text);
  const intent = hasOperationalIntent(state, text, imageUrls);

  if (!intent && !boothNumber) {
    return {
      boothNumber,
      confidence: 0.2,
      suggestedAction: "ignore",
      reason: "未识别到现场报修、催单或服务诉求"
    };
  }

  const inferredIssue = await inferIssueType(state, boothNumber, text);
  const issue = boothNumber && !inferredIssue.issueType
    ? {
        issueType: fallbackIssueType(state),
        confidence: Math.max(0.55, inferredIssue.confidence)
      }
    : inferredIssue;
  const candidates = boothNumber ? openTickets(state, boothNumber) : [];
  const sameIssueTicket = bestSameIssueTicket(candidates, issue.issueType);

  if (sameIssueTicket && issue.issueType && sameIssueTicket.issueType === issue.issueType) {
    return {
      boothNumber,
      issueType: issue.issueType,
      confidence: Math.max(0.78, issue.confidence),
      suggestedAction: "urge-existing",
      matchedTicketId: sameIssueTicket.id,
      reason: "识别到同展位、同问题类型的未关闭工单，按催单处理"
    };
  }

  if (boothNumber && issue.issueType) {
    return {
      boothNumber,
      issueType: issue.issueType,
      confidence: Math.max(0.72, issue.confidence),
      suggestedAction: "create-ticket",
      reason: "识别到展位号和问题类型，可形成新工单"
    };
  }

  return {
    boothNumber,
    issueType: issue.issueType,
    confidence: issue.confidence,
    suggestedAction: "needs-review",
    reason: boothNumber ? "已识别展位号，但问题类型需要人工确认" : "可能是现场诉求，但未识别到展位号"
  };
}

async function optionallyCreateTicket(state: AppState, record: InboundMessageRecord) {
  const integration = integrationFor(state, record.channel);
  if (!integration?.autoCreateTickets) return record.analysis;
  if (!record.analysis.boothNumber || !record.analysis.issueType) return record.analysis;
  if (!["create-ticket", "urge-existing"].includes(record.analysis.suggestedAction)) return record.analysis;

  const submitterKey = record.senderPhone || record.senderId || record.senderName;
  const submitterId = record.reporterPersonId ?? `${record.channel}-${submitterKey}`;
  const result = await createTicketService({ state }).submitTicket({
    boothNumber: record.analysis.boothNumber,
    description: record.text || record.analysis.reason,
    imageUrls: record.imageUrls,
    issueType: record.analysis.issueType,
    submitterId,
    submitterName: record.senderName,
    submitterPhone: record.senderPhone,
    reporterPersonId: record.reporterPersonId,
    reporterChatIdentityId: record.reporterChatIdentityId,
    sourceConversationId: record.sourceConversationId
  });

  return {
    ...record.analysis,
    suggestedAction: result.kind === "urged" ? "urge-existing" as const : "create-ticket" as const,
    matchedTicketId: result.ticket.id,
    reason: result.kind === "urged" ? "已自动关联未关闭工单并催单" : "已自动创建工单"
  };
}

export function createMessageIntakeService({ state }: { state: AppState }) {
  return {
    async recordMessage(input: IntakeMessageInput): Promise<InboundMessageRecord> {
      state.messageRecords ??= [];
      if (input.externalMessageId) {
        const existing = state.messageRecords.find((record) => record.channel === input.channel && record.externalMessageId === input.externalMessageId);
        if (existing) return existing;
      }

      const createdAt = now();
      const analysis = await analyzeIntakeMessage(state, input);
      const record: InboundMessageRecord = {
        id: id("message"),
        channel: input.channel,
        externalMessageId: input.externalMessageId,
        senderId: input.senderId,
        senderName: normalizeText(input.senderName) || "微信用户",
        senderPhone: normalizeText(input.senderPhone) || undefined,
        senderGroup: normalizeText(input.senderGroup) || undefined,
        text: normalizeText(input.text),
        imageUrls: input.imageUrls ?? [],
        receivedAt: input.receivedAt ?? createdAt,
        createdAt,
        reporterPersonId: input.reporterPersonId,
        reporterChatIdentityId: input.reporterChatIdentityId,
        sourceConversationId: input.sourceConversationId,
        raw: input.raw,
        analysis
      };

      state.messageRecords.push(record);

      if (!input.skipAutoCreate) {
        try {
          record.analysis = await optionallyCreateTicket(state, record);
        } catch (error) {
          console.warn("[message-intake] optionallyCreateTicket 失败", {
            messageId: record.id,
            externalMessageId: record.externalMessageId,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
          });
          record.analysis = {
            confidence: 0,
            suggestedAction: "needs-review",
            reason: "AI 处理失败，待人工审核"
          };
        }
      }

      return record;
    }
  };
}

