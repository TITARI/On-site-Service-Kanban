import type { AppState } from "../domain/app-state";
import type { AutoAcceptanceConfig, Ticket } from "../domain/types";
import type { AppConfig } from "../seed";
import { queueProcessingGroupMessage, queueTicketFeedbackMessage } from "./outbound-message-service";

export const AUTO_ACCEPTANCE_MIN_MINUTES = 1;
export const AUTO_ACCEPTANCE_MAX_MINUTES = 10080;
export const DEFAULT_AUTO_ACCEPTANCE_CONFIG: AutoAcceptanceConfig = {
  enabled: true,
  timeoutMinutes: 30
};

export function normalizeAutoAcceptanceConfig(config?: Partial<AutoAcceptanceConfig>): AutoAcceptanceConfig {
  return {
    enabled: config?.enabled ?? DEFAULT_AUTO_ACCEPTANCE_CONFIG.enabled,
    timeoutMinutes: config?.timeoutMinutes ?? DEFAULT_AUTO_ACCEPTANCE_CONFIG.timeoutMinutes
  };
}

export function validateAutoAcceptanceConfig(config?: Partial<AutoAcceptanceConfig>): AutoAcceptanceConfig {
  const normalized = normalizeAutoAcceptanceConfig(config);
  if (
    typeof normalized.timeoutMinutes !== "number" ||
    !Number.isInteger(normalized.timeoutMinutes) ||
    normalized.timeoutMinutes < AUTO_ACCEPTANCE_MIN_MINUTES ||
    normalized.timeoutMinutes > AUTO_ACCEPTANCE_MAX_MINUTES
  ) {
    throw new Error("自动验收时效需为 1 至 10080 分钟的整数");
  }
  return normalized;
}

export function autoAcceptanceReceiptBody(timeoutMinutes: number) {
  return `业务组在 ${timeoutMinutes} 分钟内未验收，系统已自动验收通过并关闭工单`;
}

export function autoAcceptanceFeedbackText(ticket: Ticket, timeoutMinutes: number) {
  return `工单已自动验收：${ticket.title}\n业务组在 ${timeoutMinutes} 分钟内未验收，系统已自动验收并关闭。`;
}

export function autoAcceptanceProcessingText(ticket: Ticket) {
  return `工单已自动验收闭环：${ticket.title}\n业务组超时未验收，系统已关闭工单。`;
}

function resolvedAt(ticket: Ticket) {
  const timelineResolvedAt = ticket.timeline
    .filter((item) => item.body.includes("状态变更为已解决"))
    .at(-1)?.createdAt;
  return timelineResolvedAt ?? ticket.updatedAt;
}

export function isTicketDueForAutoAcceptance(ticket: Ticket, config: AppConfig, nowIso: string) {
  const autoAcceptance = normalizeAutoAcceptanceConfig(config.autoAcceptance);
  if (!autoAcceptance.enabled || ticket.status !== "已解决") return false;

  const resolvedTime = new Date(resolvedAt(ticket)).getTime();
  const nowTime = new Date(nowIso).getTime();
  if (Number.isNaN(resolvedTime) || Number.isNaN(nowTime)) return false;
  return nowTime - resolvedTime >= autoAcceptance.timeoutMinutes * 60_000;
}

export function applyAutoAcceptanceToTicket(state: AppState, ticket: Ticket, nowIso: string) {
  const autoAcceptance = normalizeAutoAcceptanceConfig(state.config.autoAcceptance);
  if (!isTicketDueForAutoAcceptance(ticket, state.config, nowIso)) return false;

  ticket.status = "已关闭";
  ticket.updatedAt = nowIso;
  ticket.timeline.push({
    id: `timeline-${crypto.randomUUID()}`,
    ticketId: ticket.id,
    type: "receipt",
    body: autoAcceptanceReceiptBody(autoAcceptance.timeoutMinutes),
    createdAt: nowIso,
    actorName: "系统"
  });
  queueTicketFeedbackMessage(state, ticket, autoAcceptanceFeedbackText(ticket, autoAcceptance.timeoutMinutes));
  queueProcessingGroupMessage(state, ticket, autoAcceptanceProcessingText(ticket));
  return true;
}

export function runAutoAcceptanceForState(
  state: AppState,
  { now = new Date().toISOString() }: { now?: string } = {}
) {
  const acceptedTicketIds: string[] = [];
  for (const ticket of state.tickets) {
    if (applyAutoAcceptanceToTicket(state, ticket, now)) {
      acceptedTicketIds.push(ticket.id);
    }
  }
  return { acceptedTicketIds };
}
