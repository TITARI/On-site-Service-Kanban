import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { SESSION_COOKIE_NAMES } from "@/lib/services/session-service";

const MOBILE_TOKEN = Buffer.alloc(32, 3).toString("base64url");

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

function mobileSession() {
  return {
    actor: {
      accountId: "account-builder",
      personId: "person-builder",
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
      tokenHash: "hash-mobile",
      authVersion: 1,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      lastSeenAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    }
  };
}

function mobileRequest(body?: unknown) {
  return new Request("http://localhost/api/tickets", {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${SESSION_COOKIE_NAMES.mobile}=${MOBILE_TOKEN}`
    },
    body: body ? JSON.stringify(body) : undefined
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
    store.resolveAccountSession.mockResolvedValue(mobileSession());
    store.submitTicket.mockResolvedValue({ kind: "created", ticket: { id: "ticket-1" } });
  });

  it("runs auto acceptance before listing ticket summaries", async () => {
    const response = await GET(mobileRequest());

    expect(response.status).toBe(200);
    expect(store.runAutoAcceptance).toHaveBeenCalledOnce();
    expect(store.listTicketSummaries).toHaveBeenCalledOnce();
    expect(store.runAutoAcceptance.mock.invocationCallOrder[0]).toBeLessThan(store.listTicketSummaries.mock.invocationCallOrder[0]);
  });

  it("returns 401 for ticket list and submit when the mobile session is missing or disabled", async () => {
    const listResponse = await GET(new Request("http://localhost/api/tickets"));
    expect(listResponse.status).toBe(401);

    store.resolveAccountSession.mockResolvedValueOnce(undefined);
    const submitResponse = await POST(mobileRequest({
      boothNumber: "A01",
      description: "网络断开，现场无法扫码",
      issueType: "网络",
      imageUrls: []
    }));

    expect(submitResponse.status).toBe(401);
    expect(store.submitTicket).not.toHaveBeenCalled();
  });

  it("ignores spoofed submitter fields and uses the mobile session actor", async () => {
    const response = await POST(mobileRequest({
      boothNumber: "A01",
      description: "网络断开，现场无法扫码",
      issueType: "网络",
      imageUrls: [],
      submitterId: "person-admin",
      submitterName: "伪造管理员",
      submitterPhone: "13999999999"
    }));

    expect(response.status).toBe(200);
    expect(store.submitTicket).toHaveBeenCalledWith({
      boothNumber: "A01",
      description: "网络断开，现场无法扫码",
      issueType: "网络",
      imageUrls: [],
      submitterId: "person-builder",
      submitterName: "搭建王工",
      submitterPhone: "13700137000"
    });
  });
});
