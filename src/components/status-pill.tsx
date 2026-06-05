import type { TicketStatus } from "@/lib/domain/types";

export function StatusPill({ status }: { status: TicketStatus }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}
