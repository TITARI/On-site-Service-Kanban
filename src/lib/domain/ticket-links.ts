type TicketLike = {
  id: string;
};

function compactTicketId(ticketId: string) {
  return ticketId.trim().replace(/^ticket-/i, "").replace(/[^a-z0-9]/gi, "");
}

export function ticketShortCode(ticketId: string) {
  const compact = compactTicketId(ticketId);
  return (compact || ticketId.trim().replace(/[^a-z0-9]/gi, "")).slice(0, 8);
}

export function ticketDetailPath(ticketId: string) {
  return `/t/${ticketShortCode(ticketId)}`;
}

export function ticketDetailUrl(ticketId: string, publicBaseUrl?: string) {
  const trimmed = publicBaseUrl?.trim();
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    return new URL(ticketDetailPath(ticketId), url.origin).toString();
  } catch {
    return undefined;
  }
}

export function findTicketByShortCode<Ticket extends TicketLike>(tickets: Ticket[], code?: string | null) {
  const normalized = String(code ?? "").trim();
  if (!normalized) return undefined;
  return tickets.find((ticket) => ticket.id === normalized || ticketShortCode(ticket.id) === normalized);
}
