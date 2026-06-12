import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import type { Ticket } from "@/lib/domain/types";

const store = vi.hoisted(() => ({
  getTicket: vi.fn(),
  saveTicket: vi.fn(),
  resolveAccountSession: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    getTicket: store.getTicket,
    saveTicket: store.saveTicket,
    resolveAccountSession: store.resolveAccountSession
  } as unknown as AppRepository)
}));

const { POST } = await import("@/app/api/tickets/[ticketId]/replies/route");

const actor = {
  accountId: "account-builder",
  personId: "member-13700137000",
  name: "搭建王工",
  phone: "13700137000",
  groupId: "builder",
  groupName: "搭建组",
  permissions: ["ticket.claim", "ticket.process"] as const,
  sessionType: "mobile" as const
};

function ticket(): Ticket {
  return {
    id: "ticket-1",
    title: "A01 星河科技 搭建",
    boothNumber: "A01",
    companyName: "上海星河科技有限公司",
    companyShortName: "星河科技",
    description: "门头结构松动，需要处理",
    imageUrls: [],
    issueType: "搭建",
    submitterId: "member-13800138000",
    submitterName: "张三",
    submitterPhone: "13800138000",
    feedbackUsers: [],
    status: "处理中",
    assignmentGroup: "搭建组",
    handlerId: actor.personId,
    handlerName: actor.name,
    handlerPhone: actor.phone,
    urgeCount: 0,
    urgeLevel: 0,
    priorityScore: 20,
    aiDecisions: [],
    replies: [],
    timeline: [],
    createdAt: "2026-05-21T08:00:00.000Z",
    updatedAt: "2026-05-21T08:00:00.000Z"
  };
}

describe("ticket replies route", () => {
  beforeEach(() => {
    store.getTicket.mockReset();
    store.saveTicket.mockReset();
    store.resolveAccountSession.mockReset();
    store.getTicket.mockResolvedValue(ticket());
    store.saveTicket.mockImplementation(async (nextTicket) => nextTicket);
    store.resolveAccountSession.mockResolvedValue({
      actor,
      session: {
        id: "session-mobile",
        accountId: actor.accountId,
        sessionType: "mobile",
        tokenHash: "stored-hash",
        authVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        lastSeenAt: "2026-06-12T00:00:00.000Z",
        createdAt: "2026-06-12T00:00:00.000Z"
      }
    });
  });

  it("derives reply author fields from the mobile session", async () => {
    const response = await POST(new Request("http://localhost/api/tickets/ticket-1/replies", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `board_mobile_session=${"A".repeat(43)}`
      },
      body: JSON.stringify({
        body: "现场已补充照片",
        imageUrls: ["data:image/jpeg;base64,abc"],
        authorId: "spoofed-person",
        authorName: "伪造用户",
        authorPhone: "13900000000",
        role: "member"
      })
    }), { params: Promise.resolve({ ticketId: "ticket-1" }) });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.reply).toMatchObject({
      authorId: actor.personId,
      authorName: actor.name,
      authorPhone: actor.phone,
      role: "handler",
      body: "现场已补充照片"
    });
    expect(payload.reply.authorId).not.toBe("spoofed-person");
    expect(store.saveTicket).toHaveBeenCalledOnce();
  });

  it("rejects replies without a mobile session", async () => {
    const response = await POST(new Request("http://localhost/api/tickets/ticket-1/replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "现场已补充照片" })
    }), { params: Promise.resolve({ ticketId: "ticket-1" }) });

    expect(response.status).toBe(401);
    expect(store.getTicket).not.toHaveBeenCalled();
  });
});
