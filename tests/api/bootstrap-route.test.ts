import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@/lib/seed";
import type { Ticket } from "@/lib/domain/types";
import type { AppRepository } from "@/lib/repositories/app-repository";
import type { AppState } from "@/lib/domain/app-state";

const store = vi.hoisted(() => ({
  state: undefined as AppState | undefined,
  adminBootstrap: vi.fn(),
  mobileBootstrap: vi.fn(),
  getConfig: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    adminBootstrap: store.adminBootstrap,
    mobileBootstrap: store.mobileBootstrap,
    getConfig: store.getConfig
  } as unknown as AppRepository)
}));

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "ticket-1",
    title: "A01 test",
    boothNumber: "A01",
    companyName: "Test Company",
    companyShortName: "Test",
    description: "Network issue",
    imageUrls: [],
    issueType: "network",
    submitterId: "member-1",
    submitterName: "Member",
    feedbackUsers: [],
    status: "pending" as Ticket["status"],
    urgeCount: 0,
    urgeLevel: 0,
    priorityScore: 20,
    aiDecisions: [],
    replies: [],
    timeline: [],
    createdAt: "2026-05-21T08:00:00.000Z",
    updatedAt: "2026-05-21T08:00:00.000Z",
    ...overrides
  };
}

function state(): AppState {
  return {
    booths: [{ boothNumber: "A01", companyName: "Test Company", companyShortName: "Test", salesOwner: "Owner", builder: "Builder" }],
    tickets: [ticket()],
    messageRecords: [
      {
        id: "message-1",
        channel: "wechat",
        senderName: "Reporter",
        text: "A01 network issue",
        imageUrls: ["data:image/png;base64,large"],
        receivedAt: "2026-05-21T08:00:00.000Z",
        createdAt: "2026-05-21T08:00:00.000Z",
        analysis: { confidence: 1, suggestedAction: "create-ticket", reason: "matched" }
      }
    ],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    config: defaultConfig()
  };
}

describe("bootstrap route", () => {
  beforeEach(() => {
    store.state = state();
    store.adminBootstrap.mockReset();
    store.mobileBootstrap.mockReset();
    store.getConfig.mockReset();
    store.adminBootstrap.mockResolvedValue(store.state);
    store.mobileBootstrap.mockResolvedValue({
      tickets: store.state.tickets.map(({ imageUrls, replies, timeline, aiDecisions, ...summary }) => summary),
      config: defaultConfig()
    });
    store.getConfig.mockResolvedValue(defaultConfig());
  });

  it("opts out of route caching so query scoped responses stay separate", async () => {
    const route = await import("@/app/api/bootstrap/route");

    expect(route.dynamic).toBe("force-dynamic");
  });

  it("returns only tickets and config for mobile bootstrap requests", async () => {
    const route = await import("@/app/api/bootstrap/route");

    const response = await route.GET(new Request("http://localhost/api/bootstrap?scope=mobile"));
    const payload = await response.json();

    expect(Object.keys(payload).sort()).toEqual(["config", "tickets"]);
    expect(payload.tickets).toEqual([expect.objectContaining({ id: "ticket-1" })]);
    expect(payload.tickets[0]).not.toHaveProperty("imageUrls");
    expect(payload.tickets[0]).not.toHaveProperty("replies");
    expect(payload.tickets[0]).not.toHaveProperty("timeline");
    expect(payload.config).toEqual(defaultConfig());
  });

  it("returns only configuration for login bootstrap requests", async () => {
    const route = await import("@/app/api/bootstrap/route");

    const response = await route.GET(new Request("http://localhost/api/bootstrap?scope=login"));
    const payload = await response.json();

    expect(payload).toEqual({ config: defaultConfig() });
    expect(store.getConfig).toHaveBeenCalled();
    expect(store.mobileBootstrap).not.toHaveBeenCalled();
    expect(store.adminBootstrap).not.toHaveBeenCalled();
  });

  it("does not load the admin bootstrap payload for mobile requests", async () => {
    const route = await import("@/app/api/bootstrap/route");
    store.adminBootstrap.mockRejectedValue(new Error("admin bootstrap should not be loaded for mobile"));

    const response = await route.GET(new Request("http://localhost/api/bootstrap?scope=mobile"));

    expect(response.status).toBe(200);
    expect(store.mobileBootstrap).toHaveBeenCalled();
    expect(store.adminBootstrap).not.toHaveBeenCalled();
  });
});
