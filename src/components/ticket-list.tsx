"use client";

import { ArrowRight, Bolt, Clock3, Headphones, Network, UsersRound, Wrench } from "lucide-react";
import { formatDisplayTime } from "@/lib/domain/time-format";
import type { Ticket } from "@/lib/domain/types";
import { PriorityBadge } from "./priority-badge";
import { StatusPill } from "./status-pill";

type TicketListItem = Pick<
  Ticket,
  | "id"
  | "title"
  | "description"
  | "issueType"
  | "createdAt"
  | "lastUrgedAt"
  | "urgeCount"
  | "feedbackUsers"
  | "status"
  | "priorityScore"
>;

function issueVisual(issueType: string) {
  if (issueType.includes("网络")) return { Icon: Network, tone: "network" };
  if (issueType.includes("电")) return { Icon: Bolt, tone: "power" };
  if (issueType.includes("搭建")) return { Icon: Wrench, tone: "build" };
  return { Icon: Headphones, tone: "service" };
}

export function TicketList({ tickets, selectedId, onSelect }: { tickets: TicketListItem[]; selectedId?: string; onSelect: (id: string) => void }) {
  const groups = tickets.reduce((acc, ticket) => {
    const list = acc.get(ticket.issueType) ?? [];
    list.push(ticket);
    acc.set(ticket.issueType, list);
    return acc;
  }, new Map<string, TicketListItem[]>());

  if (tickets.length === 0) return <section className="empty-state">暂无工单</section>;

  return (
    <div className="ticket-groups">
      {Array.from(groups.entries()).map(([issueType, items]) => (
        <section className="issue-group" key={issueType}>
          <div className="group-heading">
            <h2>
              {(() => {
                const { Icon, tone } = issueVisual(issueType);
                return <span className={`group-icon issue-${tone}`}><Icon size={16} aria-hidden="true" /></span>;
              })()}
              {issueType}
            </h2>
            <span>{items.length}</span>
          </div>
          {items.map((ticket) => {
            const { Icon, tone } = issueVisual(ticket.issueType);
            return (
            <button key={ticket.id} className={`ticket-row issue-${tone} ${selectedId === ticket.id ? "selected" : ""}`} onClick={() => onSelect(ticket.id)} type="button">
              <span className="ticket-rail" aria-hidden="true" />
              <div className="ticket-icon">
                <Icon size={20} aria-hidden="true" />
              </div>
              <div className="ticket-main">
                <div className="ticket-title-line">
                  <strong>{ticket.title}</strong>
                  <span className="open-detail">点击进入详情 <ArrowRight size={13} aria-hidden="true" /></span>
                </div>
                <p>{ticket.description}</p>
                <div className="ticket-inline-meta">
                  <span><Clock3 size={13} aria-hidden="true" />提交 {formatDisplayTime(ticket.createdAt)}</span>
                  {ticket.lastUrgedAt ? (
                    <span><Clock3 size={13} aria-hidden="true" />催单 {formatDisplayTime(ticket.lastUrgedAt)}</span>
                  ) : (
                    <span><Clock3 size={13} aria-hidden="true" />催 {ticket.urgeCount}</span>
                  )}
                  <span><UsersRound size={13} aria-hidden="true" />反馈 {ticket.feedbackUsers.length}人</span>
                </div>
              </div>
              <div className="row-meta">
                <StatusPill status={ticket.status} />
                <PriorityBadge score={ticket.priorityScore} />
                <span className="chevron-bubble"><ArrowRight size={16} aria-hidden="true" /></span>
              </div>
            </button>
          );})}
        </section>
      ))}
    </div>
  );
}
