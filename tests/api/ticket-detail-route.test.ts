import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import type { Ticket } from "@/lib/domain/types";
import { SESSION_COOKIE_NAMES } from "@/lib/services/session-service";

const MOBILE_TOKEN = Buffer.alloc(32, 5).toString("base64url");

const store = vi.hoisted(() => ({
  runAutoAcceptance: vi.fn(),
  getTicket: vi.fn(),
  saveTicket: vi.fn(),
  adminBootstrap: vi.fn(),
  resolveAccountSession: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    runAutoAcceptance: store.runAutoAcceptance,
    getTicket: store.getTicket,
    saveTicket: store.saveTicket,
    adminBootstrap: store.adminBootstrap,
    resolveAccountSession: store.resolveAccountSession
  } as unknown as AppRepository)
}));

const { GET } = await import("@/app/api/tickets/[ticketId]/route");
const { POST: POST_REPLY } = await import("@/app/api/tickets/[ticketId]/replies/route");

describe("ticket detail route", () => {
  beforeEach(() => {
    store.runAutoAcceptance.mockReset();
    store.getTicket.mockReset();
    store.saveTicket.mockReset();
    store.adminBootstrap.mockReset();
    store.resolveAccountSession.mockReset();
    store.runAutoAcceptance.mockResolvedValue(undefined);
    store.saveTicket.mockImplementation(async (ticket) => ticket);
    store.resolveAccountSession.mockResolvedValue({
      actor: {
        accountId: "account-mobile",
        personId: "person-mobile",
        name: "Mobile User",
        phone: "13900139000",
        groupId: "group-mobile",
        groupName: "Mobile Group",
        permissions: [],
        sessionType: "mobile"
      },
      session: {
        id: "session-mobile",
        accountId: "account-mobile",
        sessionType: "mobile",
        tokenHash: "hash-mobile",
        authVersion: 1,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        lastSeenAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
    });
  });

  it("loads one ticket through the repository instead of loading the admin bootstrap payload", async () => {
    const ticket = { id: "ticket-1", title: "A01 网络" } as Ticket;
    store.getTicket.mockResolvedValue(ticket);
    store.adminBootstrap.mockRejectedValue(new Error("admin bootstrap should not be loaded for ticket detail"));

    const response = await GET(new Request("http://localhost/api/tickets/ticket-1", {
      headers: { Cookie: `${SESSION_COOKIE_NAMES.mobile}=${MOBILE_TOKEN}` }
    }), { params: Promise.resolve({ ticketId: "ticket-1" }) });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ticket).toEqual(ticket);
    expect(store.runAutoAcceptance).toHaveBeenCalledOnce();
    expect(store.getTicket).toHaveBeenCalledWith("ticket-1", {
      personId: "person-mobile",
      groupName: "Mobile Group",
      permissions: []
    });
    expect(store.runAutoAcceptance.mock.invocationCallOrder[0]).toBeLessThan(store.getTicket.mock.invocationCallOrder[0]);
    expect(store.adminBootstrap).not.toHaveBeenCalled();
  });

  it("returns 401 when the mobile session is missing or revoked", async () => {
    const missingResponse = await GET(new Request("http://localhost/api/tickets/ticket-1"), { params: Promise.resolve({ ticketId: "ticket-1" }) });
    expect(missingResponse.status).toBe(401);

    store.resolveAccountSession.mockResolvedValueOnce(undefined);
    const revokedResponse = await GET(new Request("http://localhost/api/tickets/ticket-1", {
      headers: { Cookie: `${SESSION_COOKIE_NAMES.mobile}=${MOBILE_TOKEN}` }
    }), { params: Promise.resolve({ ticketId: "ticket-1" }) });

    expect(revokedResponse.status).toBe(401);
    expect(store.getTicket).not.toHaveBeenCalled();
  });

  it("uses the mobile session actor for replies and ignores spoofed author fields", async () => {
    const ticket = { id: "ticket-1", title: "A01 缃戠粶", replies: [], timeline: [] } as unknown as Ticket;
    store.getTicket.mockResolvedValue(ticket);
    store.resolveAccountSession.mockResolvedValueOnce({
      actor: {
        accountId: "account-builder",
        personId: "person-builder",
        name: "搭建王工",
        phone: "13700137000",
        groupId: "builder",
        groupName: "搭建组",
        permissions: [],
        sessionType: "mobile"
      },
      session: {
        id: "session-mobile",
        accountId: "account-builder",
        sessionType: "mobile",
        tokenHash: "hash-mobile",
        authVersion: 1,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        lastSeenAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
    });

    const response = await POST_REPLY(new Request("http://localhost/api/tickets/ticket-1/replies", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE_NAMES.mobile}=${MOBILE_TOKEN}`
      },
      body: JSON.stringify({
        authorId: "person-admin",
        authorName: "伪造管理员",
        authorPhone: "13999999999",
        role: "admin",
        body: "现场已补充照片",
        imageUrls: []
      })
    }), { params: Promise.resolve({ ticketId: "ticket-1" }) });

    expect(response.status).toBe(200);
    const saved = store.saveTicket.mock.calls[0][0] as Ticket;
    expect(saved.replies.at(-1)).toMatchObject({
      authorId: "person-builder",
      authorName: "搭建王工",
      authorPhone: "13700137000",
      role: "member",
      body: "现场已补充照片"
    });
    expect(saved.timeline.at(-1)?.actorName).toBe("搭建王工");
  });

  it("returns 401 for replies when the mobile session is missing", async () => {
    const response = await POST_REPLY(new Request("http://localhost/api/tickets/ticket-1/replies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "现场已补充照片", imageUrls: [] })
    }), { params: Promise.resolve({ ticketId: "ticket-1" }) });

    expect(response.status).toBe(401);
    expect(store.saveTicket).not.toHaveBeenCalled();
  });
});
