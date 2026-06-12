import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import type { Ticket } from "@/lib/domain/types";

const store = vi.hoisted(() => ({
  runAutoAcceptance: vi.fn(),
  getTicket: vi.fn(),
  adminBootstrap: vi.fn(),
  resolveAccountSession: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    runAutoAcceptance: store.runAutoAcceptance,
    getTicket: store.getTicket,
    adminBootstrap: store.adminBootstrap,
    resolveAccountSession: store.resolveAccountSession
  } as unknown as AppRepository)
}));

const { GET } = await import("@/app/api/tickets/[ticketId]/route");

function mobileRequest() {
  return new Request("http://localhost/api/tickets/ticket-1", {
    headers: { cookie: `board_mobile_session=${"A".repeat(43)}` }
  });
}

describe("ticket detail route", () => {
  beforeEach(() => {
    store.runAutoAcceptance.mockReset();
    store.getTicket.mockReset();
    store.adminBootstrap.mockReset();
    store.resolveAccountSession.mockReset();
    store.runAutoAcceptance.mockResolvedValue(undefined);
    store.resolveAccountSession.mockResolvedValue({
      actor: {
        accountId: "account-builder",
        personId: "member-13700137000",
        name: "搭建王工",
        phone: "13700137000",
        groupId: "builder",
        groupName: "搭建组",
        permissions: ["ticket.claim", "ticket.process"],
        sessionType: "mobile"
      },
      session: {
        id: "session-mobile",
        accountId: "account-builder",
        sessionType: "mobile",
        tokenHash: "stored-hash",
        authVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        lastSeenAt: "2026-06-12T00:00:00.000Z",
        createdAt: "2026-06-12T00:00:00.000Z"
      }
    });
  });

  it("loads one ticket through the repository instead of loading the admin bootstrap payload", async () => {
    const ticket = { id: "ticket-1", title: "A01 网络" } as Ticket;
    store.getTicket.mockResolvedValue(ticket);
    store.adminBootstrap.mockRejectedValue(new Error("admin bootstrap should not be loaded for ticket detail"));

    const response = await GET(mobileRequest(), { params: Promise.resolve({ ticketId: "ticket-1" }) });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ticket).toEqual(ticket);
    expect(store.runAutoAcceptance).toHaveBeenCalledOnce();
    expect(store.getTicket).toHaveBeenCalledWith("ticket-1");
    expect(store.runAutoAcceptance.mock.invocationCallOrder[0]).toBeLessThan(store.getTicket.mock.invocationCallOrder[0]);
    expect(store.adminBootstrap).not.toHaveBeenCalled();
  });

  it("rejects ticket detail access without a mobile session", async () => {
    const response = await GET(
      new Request("http://localhost/api/tickets/ticket-1"),
      { params: Promise.resolve({ ticketId: "ticket-1" }) }
    );

    expect(response.status).toBe(401);
    expect(store.getTicket).not.toHaveBeenCalled();
  });
});
