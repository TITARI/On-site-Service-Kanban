import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";

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

const store = vi.hoisted(() => ({
  runAutoAcceptance: vi.fn(),
  listTicketSummaries: vi.fn(),
  submitTicket: vi.fn(),
  resolveAccountSession: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    runAutoAcceptance: store.runAutoAcceptance,
    listTicketSummaries: store.listTicketSummaries,
    submitTicket: store.submitTicket,
    resolveAccountSession: store.resolveAccountSession
  } as unknown as AppRepository)
}));

const { GET, POST } = await import("@/app/api/tickets/route");

function mobileRequest(url: string, init?: RequestInit) {
  return new Request(url, {
    ...init,
    headers: {
      cookie: `board_mobile_session=${"A".repeat(43)}`,
      ...init?.headers
    }
  });
}

describe("tickets route", () => {
  beforeEach(() => {
    store.runAutoAcceptance.mockReset();
    store.listTicketSummaries.mockReset();
    store.submitTicket.mockReset();
    store.resolveAccountSession.mockReset();
    store.runAutoAcceptance.mockResolvedValue(undefined);
    store.listTicketSummaries.mockResolvedValue([{ id: "ticket-1", title: "A01 网络" }]);
    store.submitTicket.mockResolvedValue({ kind: "created", ticket: { id: "ticket-1" } });
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

  it("runs auto acceptance before listing ticket summaries", async () => {
    const response = await GET(mobileRequest("http://localhost/api/tickets"));

    expect(response.status).toBe(200);
    expect(store.runAutoAcceptance).toHaveBeenCalledOnce();
    expect(store.listTicketSummaries).toHaveBeenCalledOnce();
    expect(store.runAutoAcceptance.mock.invocationCallOrder[0]).toBeLessThan(store.listTicketSummaries.mock.invocationCallOrder[0]);
  });

  it("derives the submitter from the mobile session and ignores spoofed actor fields", async () => {
    const response = await POST(mobileRequest("http://localhost/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        boothNumber: "A01",
        description: "网络断开，现场无法扫码",
        imageUrls: [],
        issueType: "网络",
        submitterId: "spoofed-person",
        submitterName: "伪造用户",
        submitterPhone: "13900000000",
        reporterPersonId: "spoofed-person"
      })
    }));

    expect(response.status).toBe(200);
    expect(store.submitTicket).toHaveBeenCalledWith({
      boothNumber: "A01",
      description: "网络断开，现场无法扫码",
      imageUrls: [],
      issueType: "网络",
      submitterId: actor.personId,
      submitterName: actor.name,
      submitterPhone: actor.phone,
      reporterPersonId: actor.personId
    });
  });

  it("rejects ticket access without a mobile session", async () => {
    const response = await GET(new Request("http://localhost/api/tickets"));

    expect(response.status).toBe(401);
    expect(store.listTicketSummaries).not.toHaveBeenCalled();
  });
});
