import type { Ticket } from "./types";

export type TicketSummary = Pick<
  Ticket,
  | "id"
  | "title"
  | "boothNumber"
  | "companyName"
  | "companyShortName"
  | "description"
  | "issueType"
  | "submitterId"
  | "submitterName"
  | "submitterPhone"
  | "feedbackUsers"
  | "status"
  | "acceptedAt"
  | "handlerId"
  | "handlerName"
  | "handlerPhone"
  | "assignmentGroup"
  | "urgeCount"
  | "lastUrgedAt"
  | "urgeLevel"
  | "priorityScore"
  | "createdAt"
  | "updatedAt"
>;

export function toTicketSummary(ticket: Ticket): TicketSummary {
  return {
    id: ticket.id,
    title: ticket.title,
    boothNumber: ticket.boothNumber,
    companyName: ticket.companyName,
    companyShortName: ticket.companyShortName,
    description: ticket.description,
    issueType: ticket.issueType,
    submitterId: ticket.submitterId,
    submitterName: ticket.submitterName,
    submitterPhone: ticket.submitterPhone,
    feedbackUsers: ticket.feedbackUsers,
    status: ticket.status,
    acceptedAt: ticket.acceptedAt,
    handlerId: ticket.handlerId,
    handlerName: ticket.handlerName,
    handlerPhone: ticket.handlerPhone,
    assignmentGroup: ticket.assignmentGroup,
    urgeCount: ticket.urgeCount,
    lastUrgedAt: ticket.lastUrgedAt,
    urgeLevel: ticket.urgeLevel,
    priorityScore: ticket.priorityScore,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt
  };
}
