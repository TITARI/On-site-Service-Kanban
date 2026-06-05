import { describe, expect, it } from "vitest";
import { calculatePriorityScore, sortTicketsByPriority } from "@/lib/domain/priority";
import { escalateTimedOutTicket, refreshTicketPriority } from "@/lib/services/escalation-service";
import type { Ticket } from "@/lib/domain/types";

function ticket(overrides: Partial<Ticket>): Ticket {
  return {
    id: "T-1",
    title: "A01 星河 网络",
    boothNumber: "A01",
    companyName: "星河",
    companyShortName: "星河",
    description: "网络断了",
    imageUrls: [],
    issueType: "网络",
    submitterId: "u1",
    submitterName: "张三",
    feedbackUsers: [],
    status: "处理中",
    handlerId: "h1",
    handlerName: "李工",
    urgeCount: 0,
    urgeLevel: 0,
    priorityScore: 0,
    aiDecisions: [],
    replies: [],
    timeline: [],
    createdAt: "2026-05-21T08:00:00.000Z",
    updatedAt: "2026-05-21T08:00:00.000Z",
    ...overrides
  };
}

describe("priority", () => {
  it("uses severity, urge count and accepted elapsed minutes", () => {
    expect(calculatePriorityScore({ issueWeight: 20, riskWeight: 15, urgeCount: 2, acceptedElapsedMinutes: 30 })).toBe(85);
  });

  it("includes timeout escalation level in priority score", () => {
    expect(calculatePriorityScore({ issueWeight: 20, riskWeight: 15, urgeCount: 2, acceptedElapsedMinutes: 30, urgeLevel: 2 })).toBe(115);
  });

  it("sorts urgent tickets first", () => {
    const sorted = sortTicketsByPriority([
      ticket({ id: "low", priorityScore: 10, createdAt: "2026-05-21T08:00:00.000Z" }),
      ticket({ id: "high", priorityScore: 90, createdAt: "2026-05-21T09:00:00.000Z" })
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["high", "low"]);
  });

  it("uses last urge time and then created time when scores tie", () => {
    const sorted = sortTicketsByPriority([
      ticket({ id: "old", priorityScore: 50, createdAt: "2026-05-21T08:00:00.000Z" }),
      ticket({ id: "newer-urge", priorityScore: 50, lastUrgedAt: "2026-05-21T10:00:00.000Z", createdAt: "2026-05-21T09:00:00.000Z" }),
      ticket({ id: "older-urge", priorityScore: 50, lastUrgedAt: "2026-05-21T09:00:00.000Z", createdAt: "2026-05-21T07:00:00.000Z" })
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["newer-urge", "older-urge", "old"]);
  });

  it("adds timeout escalation data and keeps priority refreshable", () => {
    const base = ticket({ priorityScore: 10, urgeLevel: 2, acceptedAt: "2026-05-21T08:00:00.000Z" });
    const escalated = escalateTimedOutTicket(base, "优先核查网络线路", "2026-05-21T09:00:00.000Z", 20);
    const refreshed = refreshTicketPriority(escalated, 20, "2026-05-21T09:00:00.000Z");

    expect(escalated.urgeLevel).toBe(3);
    expect(escalated.priorityScore).toBe(refreshed.priorityScore);
    expect(escalated.aiDecisions.at(-1)?.scenario).toBe("escalation");
    expect(escalated.timeline.at(-1)?.type).toBe("ai-suggestion");
    expect(refreshed.priorityScore).toBe(20 + 20 + 0 + 60 + 45);
  });

  it("does not stack extra timeout score after urge level reaches the cap", () => {
    const base = ticket({ priorityScore: 500, urgeLevel: 3, acceptedAt: "2026-05-21T08:00:00.000Z" });
    const escalated = escalateTimedOutTicket(base, "继续优先核查", "2026-05-21T09:00:00.000Z", 20);
    const refreshed = refreshTicketPriority(escalated, 20, "2026-05-21T09:00:00.000Z");

    expect(escalated.urgeLevel).toBe(3);
    expect(escalated.priorityScore).toBe(refreshed.priorityScore);
    expect(refreshed.priorityScore).toBe(20 + 20 + 0 + 60 + 45);
  });
});
