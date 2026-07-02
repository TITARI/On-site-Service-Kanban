import { describe, expect, it } from "vitest";
import { escalateTimedOutTicket, refreshTicketPriority } from "@/lib/services/escalation-service";
import type { Ticket } from "@/lib/domain/types";

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "T-1",
    title: "A01 星河 网络",
    boothNumber: "A01",
    companyName: "星河",
    companyShortName: "星河",
    description: "现场设备需要检查",
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

describe("escalation service - escalateTimedOutTicket", () => {
  it("appends an ai-suggestion timeline entry carrying the suggestion", () => {
    const base = ticket({ acceptedAt: "2026-05-21T08:00:00.000Z" });

    const escalated = escalateTimedOutTicket(base, "优先核查网络线路", "2026-05-21T09:00:00.000Z", 20);

    const entry = escalated.timeline.at(-1);
    expect(escalated.timeline).toHaveLength(1);
    expect(entry?.type).toBe("ai-suggestion");
    expect(entry?.body).toBe("优先核查网络线路");
    expect(entry?.ticketId).toBe(base.id);
    expect(entry?.createdAt).toBe("2026-05-21T09:00:00.000Z");
    expect(entry?.actorName).toBeTruthy();
    expect(entry?.id).toBeTruthy();
  });

  it("appends an escalation ai decision with manual-review action", () => {
    const base = ticket({ acceptedAt: "2026-05-21T08:00:00.000Z" });

    const escalated = escalateTimedOutTicket(base, "优先核查网络线路", "2026-05-21T09:00:00.000Z", 20);

    const decision = escalated.aiDecisions.at(-1);
    expect(escalated.aiDecisions).toHaveLength(1);
    expect(decision?.scenario).toBe("escalation");
    expect(decision?.action).toBe("manual-review");
    expect(decision?.suggestion).toBe("优先核查网络线路");
    expect(decision?.confidence).toBe(0.8);
  });

  it("increments the urge level by one", () => {
    const escalated = escalateTimedOutTicket(ticket({ urgeLevel: 1 }), "催办", "2026-05-21T09:00:00.000Z", 0);

    expect(escalated.urgeLevel).toBe(2);
  });

  it("caps the urge level at three", () => {
    const escalated = escalateTimedOutTicket(ticket({ urgeLevel: 3 }), "催办", "2026-05-21T09:00:00.000Z", 0);

    expect(escalated.urgeLevel).toBe(3);
  });

  it("recomputes the priority score for the new urge level", () => {
    const base = ticket({ urgeLevel: 1, urgeCount: 2, acceptedAt: "2026-05-21T08:00:00.000Z" });

    const escalated = escalateTimedOutTicket(base, "催办", "2026-05-21T09:00:00.000Z", 20);

    // issueWeight(20) + riskWeight(0) + urgeCount(2)*10 + elapsed(60) + urgeLevel(2)*15
    expect(escalated.priorityScore).toBe(20 + 0 + 20 + 60 + 30);
    expect(escalated.updatedAt).toBe("2026-05-21T09:00:00.000Z");
  });

  it("does not mutate the original ticket", () => {
    const base = ticket({ urgeLevel: 1, acceptedAt: "2026-05-21T08:00:00.000Z" });

    escalateTimedOutTicket(base, "催办", "2026-05-21T09:00:00.000Z", 20);

    expect(base.urgeLevel).toBe(1);
    expect(base.timeline).toHaveLength(0);
    expect(base.aiDecisions).toHaveLength(0);
    expect(base.updatedAt).toBe("2026-05-21T08:00:00.000Z");
  });
});

describe("escalation service - refreshTicketPriority", () => {
  it("computes score from issue weight, urge count and accepted elapsed minutes", () => {
    const base = ticket({ urgeCount: 2, urgeLevel: 1, acceptedAt: "2026-05-21T08:00:00.000Z" });

    const refreshed = refreshTicketPriority(base, 20, "2026-05-21T08:30:00.000Z");

    // 20 + 0 + 2*10 + 30 + 1*15
    expect(refreshed.priorityScore).toBe(20 + 0 + 20 + 30 + 15);
    expect(refreshed.updatedAt).toBe("2026-05-21T08:30:00.000Z");
  });

  it("adds the high risk weight detected from the description", () => {
    const base = ticket({ description: "展位有安全隐患需要立即处理", acceptedAt: "2026-05-21T08:00:00.000Z" });

    const refreshed = refreshTicketPriority(base, 10, "2026-05-21T08:00:00.000Z");

    // 10 + highRisk(40) + 0 + 0 + 0
    expect(refreshed.priorityScore).toBe(10 + 40);
  });

  it("treats a missing accepted time as zero elapsed minutes", () => {
    const base = ticket({ acceptedAt: undefined });

    const refreshed = refreshTicketPriority(base, 15, "2026-05-21T09:00:00.000Z");

    expect(refreshed.priorityScore).toBe(15);
  });

  it("does not mutate the original ticket", () => {
    const base = ticket({ priorityScore: 5, acceptedAt: "2026-05-21T08:00:00.000Z" });

    refreshTicketPriority(base, 20, "2026-05-21T09:00:00.000Z");

    expect(base.priorityScore).toBe(5);
    expect(base.updatedAt).toBe("2026-05-21T08:00:00.000Z");
  });
});
