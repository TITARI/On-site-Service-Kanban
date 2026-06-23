import { createConfiguredAiProvider } from "../ai/provider";
import { createAiRouter } from "../ai/router";
import { decideDeduplication } from "../domain/deduplication";
import { calculatePriorityScore, detectRiskWeight } from "../domain/priority";
import type { BoothRecord, Ticket } from "../domain/types";
import { createTicketTitle, elapsedSinceAccepted } from "../domain/workflow";
import type { AppState } from "../domain/app-state";

const FALLBACK_ISSUE_TYPE = "综合服务";

type TicketAiRouter = ReturnType<typeof createAiRouter>;
type ClassifyDecision = Awaited<ReturnType<TicketAiRouter["classifyIssue"]>>;
type DedupeDecision = Awaited<ReturnType<TicketAiRouter["dedupeIssue"]>>;

export type SubmitTicketInput = {
  boothNumber: string;
  description: string;
  imageUrls: string[];
  issueType: string;
  submitterId: string;
  submitterName: string;
  submitterPhone?: string;
  reporterPersonId?: string;
  reporterChatIdentityId?: string;
  sourceConversationId?: string;
};

export type SubmitTicketResult = {
  kind: "created" | "urged" | "manual-review";
  ticket: Ticket;
};

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function findBooth(booths: BoothRecord[], boothNumber: string): BoothRecord {
  return booths.find((booth) => booth.boothNumber === boothNumber) ?? {
    boothNumber,
    companyName: "未知公司",
    companyShortName: "未知公司",
    salesOwner: "",
    builder: ""
  };
}

function assignHandler(state: AppState, boothNumber: string, issueType: string) {
  return state.config.assignmentRules.find((rule) => boothNumber.startsWith(rule.boothPattern) && rule.issueType === issueType);
}

function issueWeight(state: AppState, issueType: string) {
  return state.config.issueTypes.find((item) => item.name === issueType)?.priorityWeight ?? 0;
}

function issueAssignmentGroup(state: AppState, issueType: string) {
  return state.config.issueTypes.find((item) => item.name === issueType)?.assignmentGroup;
}

async function safeClassify(ai: TicketAiRouter, boothNumber: string, description: string): Promise<ClassifyDecision | undefined> {
  try {
    return await ai.classifyIssue(boothNumber, description);
  } catch (error) {
    console.warn("[ticket-service] classifyIssue 失败，使用降级值", {
      modelId: "fast",
      scenario: "classify",
      boothNumber,
      descriptionLength: description.length,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    });
    return undefined;
  }
}

async function safeDedupe(
  ai: TicketAiRouter,
  boothNumber: string,
  description: string,
  candidates: Ticket[]
): Promise<DedupeDecision> {
  try {
    return await ai.dedupeIssue(boothNumber, description, candidates);
  } catch (error) {
    console.warn("[ticket-service] dedupeIssue 失败，降级为创建新工单", {
      modelId: "smart",
      scenario: "dedupe",
      boothNumber,
      descriptionLength: description.length,
      candidateCount: candidates.length,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    });
    return {
      modelId: "smart",
      scenario: "dedupe",
      confidence: 0,
      action: "create",
      suggestion: "AI dedupe 不可用，默认创建新工单",
      latencyMs: 0
    };
  }
}

export function createTicketService({ state }: { state: AppState }) {
  const ai = createAiRouter({ models: state.config.aiModels, provider: createConfiguredAiProvider(), promptConfig: state.config });

  return {
    async submitTicket(input: SubmitTicketInput): Promise<SubmitTicketResult> {
      const createdAt = now();
      const boothNumber = input.boothNumber.trim();
      const description = input.description.trim();
      const booth = findBooth(state.booths, boothNumber);
      const classification = input.issueType === "自动"
        ? await safeClassify(ai, boothNumber, description)
        : undefined;
      const issueType = input.issueType === "自动" ? classification?.issueType ?? FALLBACK_ISSUE_TYPE : input.issueType;
      const candidates = state.tickets.filter((ticket) => ticket.boothNumber === boothNumber && ticket.status !== "已关闭");
      const dedupe = await safeDedupe(ai, boothNumber, description, candidates);
      const dedupeAction = decideDeduplication(dedupe.confidence);
      const matched = candidates.find((ticket) => ticket.id === dedupe.matchedTicketId);

      if (dedupeAction === "urge" && matched) {
        matched.urgeCount += 1;
        matched.lastUrgedAt = createdAt;
        matched.urgeLevel = Math.min(3, matched.urgeLevel + 1) as Ticket["urgeLevel"];
        const existingFeedbackUser = matched.feedbackUsers.find((user) => user.userId === input.submitterId);
        if (existingFeedbackUser) {
          existingFeedbackUser.userName = input.submitterName;
          existingFeedbackUser.phone = input.submitterPhone;
          existingFeedbackUser.feedbackAt = createdAt;
        } else {
          matched.feedbackUsers.push({ userId: input.submitterId, userName: input.submitterName, phone: input.submitterPhone, feedbackAt: createdAt });
        }
        matched.priorityScore = calculatePriorityScore({
          issueWeight: issueWeight(state, matched.issueType),
          riskWeight: detectRiskWeight(matched.description),
          urgeCount: matched.urgeCount,
          acceptedElapsedMinutes: elapsedSinceAccepted(matched.acceptedAt, createdAt),
          urgeLevel: matched.urgeLevel
        });
        matched.aiDecisions.push({ ...dedupe, action: "urge" });
        matched.timeline.push({
          id: id("timeline"),
          ticketId: matched.id,
          type: "urged",
          body: `${input.submitterName}反馈了相似问题，系统按催单处理。`,
          createdAt,
          actorName: "系统AI"
        });
        matched.updatedAt = createdAt;
        return { kind: "urged", ticket: matched };
      }

      const rule = assignHandler(state, boothNumber, issueType);
      const assignmentGroup = rule?.groupName ?? issueAssignmentGroup(state, issueType);
      const ticketId = id("ticket");
      const timeline: Ticket["timeline"] = [
        { id: id("timeline"), ticketId, type: "submitted", body: description, createdAt, actorName: input.submitterName }
      ];
      if (rule) {
        timeline.push({
          id: id("timeline"),
          ticketId,
          type: "assigned",
          body: `系统已按展位号和问题类型指派给${rule.handlerName}`,
          createdAt,
          actorName: "系统"
        });
      }
      const ticket: Ticket = {
        id: ticketId,
        title: createTicketTitle(boothNumber, booth.companyShortName, issueType),
        boothNumber,
        companyName: booth.companyName,
        companyShortName: booth.companyShortName,
        description,
        imageUrls: input.imageUrls,
        issueType,
        submitterId: input.submitterId,
        submitterName: input.submitterName,
        submitterPhone: input.submitterPhone,
        reporterPersonId: input.reporterPersonId,
        reporterChatIdentityId: input.reporterChatIdentityId,
        sourceConversationId: input.sourceConversationId,
        feedbackUsers: [{ userId: input.submitterId, userName: input.submitterName, phone: input.submitterPhone, feedbackAt: createdAt }],
        status: "待受理",
        handlerId: rule?.handlerId,
        handlerName: rule?.handlerName,
        assignmentGroup,
        urgeCount: 0,
        urgeLevel: 0,
        priorityScore: issueWeight(state, issueType) + detectRiskWeight(description),
        aiDecisions: [classification, { ...dedupe, action: dedupeAction }].filter(Boolean) as Ticket["aiDecisions"],
        replies: [],
        timeline,
        createdAt,
        updatedAt: createdAt
      };

      state.tickets.push(ticket);
      return { kind: dedupeAction === "manual-review" ? "manual-review" : "created", ticket };
    }
  };
}

