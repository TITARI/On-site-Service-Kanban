import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import type { Ticket } from "@/lib/domain/types";

const store = vi.hoisted(() => ({
  runAutoAcceptance: vi.fn(),
  getTicket: vi.fn(),
  adminBootstrap: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    runAutoAcceptance: store.runAutoAcceptance,
    getTicket: store.getTicket,
    adminBootstrap: store.adminBootstrap
  } as unknown as AppRepository)
}));

const { GET } = await import("@/app/api/tickets/[ticketId]/route");

describe("ticket detail route", () => {
  beforeEach(() => {
    store.runAutoAcceptance.mockReset();
    store.getTicket.mockReset();
    store.adminBootstrap.mockReset();
    store.runAutoAcceptance.mockResolvedValue(undefined);
  });

  it("loads one ticket through the repository instead of loading the admin bootstrap payload", async () => {
    const ticket = { id: "ticket-1", title: "A01 网络" } as Ticket;
    store.getTicket.mockResolvedValue(ticket);
    store.adminBootstrap.mockRejectedValue(new Error("admin bootstrap should not be loaded for ticket detail"));

    const response = await GET(new Request("http://localhost/api/tickets/ticket-1"), { params: Promise.resolve({ ticketId: "ticket-1" }) });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ticket).toEqual(ticket);
    expect(store.runAutoAcceptance).toHaveBeenCalledOnce();
    expect(store.getTicket).toHaveBeenCalledWith("ticket-1");
    expect(store.runAutoAcceptance.mock.invocationCallOrder[0]).toBeLessThan(store.getTicket.mock.invocationCallOrder[0]);
    expect(store.adminBootstrap).not.toHaveBeenCalled();
  });
});
