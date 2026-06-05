import type { Ticket } from "./types";

export const PRIORITY_WEIGHTS = {
  urge: 10,
  timeoutEscalation: 15,
  highRisk: 40,
  mediumRisk: 20
} as const;

export function calculatePriorityScore(input: {
  issueWeight: number;
  riskWeight: number;
  urgeCount: number;
  acceptedElapsedMinutes: number;
  urgeLevel?: number;
}) {
  return (
    input.issueWeight +
    input.riskWeight +
    input.urgeCount * PRIORITY_WEIGHTS.urge +
    input.acceptedElapsedMinutes +
    (input.urgeLevel ?? 0) * PRIORITY_WEIGHTS.timeoutEscalation
  );
}

export function detectRiskWeight(description: string) {
  if (/安全|漏电|坍塌|受伤|火|烟/.test(description)) return PRIORITY_WEIGHTS.highRisk;
  if (/断网|网络.*断|断.*网|断电|无法|投诉|拥堵/.test(description)) return PRIORITY_WEIGHTS.mediumRisk;
  return 0;
}

function safeTime(value: string | undefined, fallback = 0) {
  if (!value) return fallback;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : fallback;
}

export function sortTicketsByPriority(tickets: Ticket[]) {
  return [...tickets].sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    const aUrged = safeTime(a.lastUrgedAt);
    const bUrged = safeTime(b.lastUrgedAt);
    if (bUrged !== aUrged) return bUrged - aUrged;
    return safeTime(a.createdAt) - safeTime(b.createdAt);
  });
}
