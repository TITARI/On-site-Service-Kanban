import type { Ticket } from "../domain/types";
import { calculatePriorityScore, detectRiskWeight } from "../domain/priority";
import { elapsedSinceAccepted } from "../domain/workflow";

export function refreshTicketPriority(ticket: Ticket, issueWeight: number, nowIso = new Date().toISOString()): Ticket {
  const acceptedElapsedMinutes = elapsedSinceAccepted(ticket.acceptedAt, nowIso);
  const priorityScore = calculatePriorityScore({
    issueWeight,
    riskWeight: detectRiskWeight(ticket.description),
    urgeCount: ticket.urgeCount,
    acceptedElapsedMinutes,
    urgeLevel: ticket.urgeLevel
  });

  return { ...ticket, priorityScore, updatedAt: nowIso };
}

export function escalateTimedOutTicket(ticket: Ticket, suggestion: string, nowIso = new Date().toISOString(), issueWeight = 0): Ticket {
  const urgeLevel = Math.min(3, ticket.urgeLevel + 1) as Ticket["urgeLevel"];
  const priorityScore = calculatePriorityScore({
    issueWeight,
    riskWeight: detectRiskWeight(ticket.description),
    urgeCount: ticket.urgeCount,
    acceptedElapsedMinutes: elapsedSinceAccepted(ticket.acceptedAt, nowIso),
    urgeLevel
  });

  return {
    ...ticket,
    urgeLevel,
    priorityScore,
    aiDecisions: [
      ...ticket.aiDecisions,
      {
        modelId: "smart",
        scenario: "escalation",
        confidence: 0.8,
        action: "manual-review",
        suggestion,
        latencyMs: 0
      }
    ],
    timeline: [
      ...ticket.timeline,
      {
        id: crypto.randomUUID(),
        ticketId: ticket.id,
        type: "ai-suggestion",
        body: suggestion,
        createdAt: nowIso,
        actorName: "系统AI"
      }
    ],
    updatedAt: nowIso
  };
}
