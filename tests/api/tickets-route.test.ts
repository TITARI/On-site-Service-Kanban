import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";

const store = vi.hoisted(() => ({
  runAutoAcceptance: vi.fn(),
  listTicketSummaries: vi.fn(),
  submitTicket: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    runAutoAcceptance: store.runAutoAcceptance,
    listTicketSummaries: store.listTicketSummaries,
    submitTicket: store.submitTicket
  } as unknown as AppRepository)
}));

const { GET } = await import("@/app/api/tickets/route");

describe("tickets route", () => {
  beforeEach(() => {
    store.runAutoAcceptance.mockReset();
    store.listTicketSummaries.mockReset();
    store.submitTicket.mockReset();
    store.runAutoAcceptance.mockResolvedValue(undefined);
    store.listTicketSummaries.mockResolvedValue([{ id: "ticket-1", title: "A01 网络" }]);
  });

  it("runs auto acceptance before listing ticket summaries", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(store.runAutoAcceptance).toHaveBeenCalledOnce();
    expect(store.listTicketSummaries).toHaveBeenCalledOnce();
    expect(store.runAutoAcceptance.mock.invocationCallOrder[0]).toBeLessThan(store.listTicketSummaries.mock.invocationCallOrder[0]);
  });
});
