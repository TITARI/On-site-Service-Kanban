import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@/lib/seed";
import type { Ticket } from "@/lib/domain/types";
import type { AppRepository } from "@/lib/repositories/app-repository";
import type { AppState } from "@/lib/domain/app-state";

const store = vi.hoisted(() => ({
  state: undefined as AppState | undefined,
  runAutoAcceptance: vi.fn(),
  adminBootstrap: vi.fn(),
  mobileBootstrap: vi.fn(),
  getConfig: vi.fn()
}));

const fallbackStore = vi.hoisted(() => ({
  state: undefined as AppState | undefined,
  runAutoAcceptance: vi.fn(),
  adminBootstrap: vi.fn(),
  mobileBootstrap: vi.fn(),
  getConfig: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  createFileAppRepository: (): AppRepository => ({
    kind: "file",
    runAutoAcceptance: fallbackStore.runAutoAcceptance,
    adminBootstrap: fallbackStore.adminBootstrap,
    mobileBootstrap: fallbackStore.mobileBootstrap,
    getConfig: fallbackStore.getConfig
  } as unknown as AppRepository),
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    runAutoAcceptance: store.runAutoAcceptance,
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
    store.runAutoAcceptance.mockReset();
    store.adminBootstrap.mockReset();
    store.mobileBootstrap.mockReset();
    store.getConfig.mockReset();
    fallbackStore.state = state();
    fallbackStore.runAutoAcceptance.mockReset();
    fallbackStore.adminBootstrap.mockReset();
    fallbackStore.mobileBootstrap.mockReset();
    fallbackStore.getConfig.mockReset();
    store.runAutoAcceptance.mockResolvedValue(undefined);
    store.adminBootstrap.mockResolvedValue(store.state);
    store.mobileBootstrap.mockResolvedValue({
      tickets: store.state.tickets.map(({ imageUrls, replies, timeline, aiDecisions, ...summary }) => summary),
      config: defaultConfig()
    });
    store.getConfig.mockResolvedValue(defaultConfig());
    fallbackStore.runAutoAcceptance.mockResolvedValue(undefined);
    fallbackStore.adminBootstrap.mockResolvedValue(fallbackStore.state);
    fallbackStore.mobileBootstrap.mockResolvedValue({
      tickets: fallbackStore.state.tickets.map(({ imageUrls, replies, timeline, aiDecisions, ...summary }) => ({
        ...summary,
        id: "fallback-ticket"
      })),
      config: defaultConfig()
    });
    fallbackStore.getConfig.mockResolvedValue(defaultConfig());
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
    expect(store.runAutoAcceptance).toHaveBeenCalledOnce();
    expect(store.runAutoAcceptance.mock.invocationCallOrder[0]).toBeLessThan(store.mobileBootstrap.mock.invocationCallOrder[0]);
  });

  it("returns only configuration for login bootstrap requests", async () => {
    const route = await import("@/app/api/bootstrap/route");

    const response = await route.GET(new Request("http://localhost/api/bootstrap?scope=login"));
    const payload = await response.json();

    expect(payload).toEqual({ config: defaultConfig() });
    expect(store.runAutoAcceptance).not.toHaveBeenCalled();
    expect(store.getConfig).toHaveBeenCalled();
    expect(store.mobileBootstrap).not.toHaveBeenCalled();
    expect(store.adminBootstrap).not.toHaveBeenCalled();
  });

  it("does not load the admin bootstrap payload for mobile requests", async () => {
    const route = await import("@/app/api/bootstrap/route");
    store.adminBootstrap.mockRejectedValue(new Error("admin bootstrap should not be loaded for mobile"));

    const response = await route.GET(new Request("http://localhost/api/bootstrap?scope=mobile"));

    expect(response.status).toBe(200);
    expect(store.runAutoAcceptance).toHaveBeenCalledOnce();
    expect(store.mobileBootstrap).toHaveBeenCalled();
    expect(store.adminBootstrap).not.toHaveBeenCalled();
  });

  it("falls back to JSON bootstrap data when MariaDB is not ready for mobile requests", async () => {
    const route = await import("@/app/api/bootstrap/route");
    store.mobileBootstrap.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), { code: "ECONNREFUSED" }));

    const response = await route.GET(new Request("http://localhost/api/bootstrap?scope=mobile"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.tickets).toEqual([expect.objectContaining({ id: "fallback-ticket" })]);
    expect(payload.storage).toEqual(expect.objectContaining({ mode: "file", fallback: true }));
    expect(fallbackStore.mobileBootstrap).toHaveBeenCalled();
  });

  it("falls back to JSON config when MariaDB is not ready for login bootstrap", async () => {
    const route = await import("@/app/api/bootstrap/route");
    store.getConfig.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), { code: "ECONNREFUSED" }));

    const response = await route.GET(new Request("http://localhost/api/bootstrap?scope=login"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.config).toEqual(defaultConfig());
    expect(payload.storage).toEqual(expect.objectContaining({ mode: "file", fallback: true }));
    expect(fallbackStore.getConfig).toHaveBeenCalled();
  });

  it("returns a clear degraded error when neither MariaDB nor JSON bootstrap can load", async () => {
    const route = await import("@/app/api/bootstrap/route");
    store.adminBootstrap.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), { code: "ECONNREFUSED" }));
    fallbackStore.adminBootstrap.mockRejectedValue(new Error("state file is broken"));

    const response = await route.GET(new Request("http://localhost/api/bootstrap"));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual(expect.objectContaining({
      message: "数据源暂不可用",
      storage: expect.objectContaining({ mode: "file", fallback: false })
    }));
  });
});
