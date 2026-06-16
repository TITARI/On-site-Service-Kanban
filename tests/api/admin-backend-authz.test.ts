import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type AppConfig } from "@/lib/seed";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { SESSION_COOKIE_NAMES } from "@/lib/services/session-service";

const MOBILE_TOKEN = Buffer.alloc(32, 2).toString("base64url");

const store = vi.hoisted(() => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  saveKeywordGroups: vi.fn(),
  importBooths: vi.fn(),
  listWechatOrderLogs: vi.fn(),
  runAutoAcceptance: vi.fn(),
  adminBootstrap: vi.fn(),
  mobileBootstrap: vi.fn(),
  resolveAccountSession: vi.fn()
}));

const fallbackStore = vi.hoisted(() => ({
  getConfig: vi.fn(),
  runAutoAcceptance: vi.fn(),
  adminBootstrap: vi.fn(),
  mobileBootstrap: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  createFileAppRepository: (): AppRepository => ({
    kind: "file",
    getConfig: fallbackStore.getConfig,
    runAutoAcceptance: fallbackStore.runAutoAcceptance,
    adminBootstrap: fallbackStore.adminBootstrap,
    mobileBootstrap: fallbackStore.mobileBootstrap
  } as unknown as AppRepository),
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    getConfig: store.getConfig,
    saveConfig: store.saveConfig,
    saveKeywordGroups: store.saveKeywordGroups,
    importBooths: store.importBooths,
    listWechatOrderLogs: store.listWechatOrderLogs,
    runAutoAcceptance: store.runAutoAcceptance,
    adminBootstrap: store.adminBootstrap,
    mobileBootstrap: store.mobileBootstrap,
    resolveAccountSession: store.resolveAccountSession
  } as unknown as AppRepository)
}));

function jsonRequest(url: string, method: "POST" | "PUT", body: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function expectUnauthenticated(response: Response) {
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ message: "Unauthenticated" });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  for (const mock of Object.values(store)) mock.mockReset();
  for (const mock of Object.values(fallbackStore)) mock.mockReset();

  const config: AppConfig = defaultConfig();
  store.getConfig.mockResolvedValue(config);
  store.saveConfig.mockResolvedValue(config);
  store.saveKeywordGroups.mockResolvedValue([]);
  store.importBooths.mockResolvedValue([]);
  store.listWechatOrderLogs.mockResolvedValue([]);
  store.runAutoAcceptance.mockResolvedValue(undefined);
  store.adminBootstrap.mockResolvedValue({
    tickets: [],
    booths: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    config
  });
  store.mobileBootstrap.mockResolvedValue({ tickets: [], config });
  store.resolveAccountSession.mockResolvedValue(undefined);

  fallbackStore.getConfig.mockResolvedValue(config);
  fallbackStore.runAutoAcceptance.mockResolvedValue(undefined);
  fallbackStore.adminBootstrap.mockResolvedValue({
    tickets: [],
    booths: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    config
  });
  fallbackStore.mobileBootstrap.mockResolvedValue({ tickets: [], config });
});

describe("admin backend route authorization", () => {
  it("rejects unauthenticated admin bootstrap payload requests before loading backend data", async () => {
    const route = await import("@/app/api/bootstrap/route");

    await expectUnauthenticated(await route.GET(new Request("http://localhost/api/bootstrap")));

    expect(store.runAutoAcceptance).not.toHaveBeenCalled();
    expect(store.adminBootstrap).not.toHaveBeenCalled();
  });

  it("keeps login bootstrap public and mobile bootstrap available with a mobile session", async () => {
    const route = await import("@/app/api/bootstrap/route");
    store.resolveAccountSession.mockResolvedValueOnce({
      actor: {
        accountId: "account-mobile",
        personId: "person-mobile",
        name: "Mobile User",
        phone: "13900139000",
        groupId: "group-mobile",
        groupName: "Mobile Group",
        permissions: ["ticket.claim"],
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

    const loginResponse = await route.GET(new Request("http://localhost/api/bootstrap?scope=login"));
    const mobileResponse = await route.GET(new Request("http://localhost/api/bootstrap?scope=mobile", {
      headers: { Cookie: `${SESSION_COOKIE_NAMES.mobile}=${MOBILE_TOKEN}` }
    }));

    expect(loginResponse.status).toBe(200);
    expect(mobileResponse.status).toBe(200);
    expect(store.getConfig).toHaveBeenCalledOnce();
    expect(store.mobileBootstrap).toHaveBeenCalledOnce();
    expect(store.adminBootstrap).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated admin config reads and writes", async () => {
    const route = await import("@/app/api/admin/config/route");

    await expectUnauthenticated(await route.GET(new Request("http://localhost/api/admin/config")));
    await expectUnauthenticated(await route.PUT(jsonRequest("http://localhost/api/admin/config", "PUT", { config: defaultConfig() })));

    expect(store.getConfig).not.toHaveBeenCalled();
    expect(store.saveConfig).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated keyword reads and writes", async () => {
    const route = await import("@/app/api/admin/keywords/route");

    await expectUnauthenticated(await route.GET(new Request("http://localhost/api/admin/keywords")));
    await expectUnauthenticated(await route.PUT(jsonRequest("http://localhost/api/admin/keywords", "PUT", { keywordGroups: [] })));

    expect(store.getConfig).not.toHaveBeenCalled();
    expect(store.saveKeywordGroups).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated master-data imports", async () => {
    const route = await import("@/app/api/admin/master-data/route");

    await expectUnauthenticated(await route.POST(jsonRequest("http://localhost/api/admin/master-data", "POST", { rows: [] })));

    expect(store.importBooths).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated WeChat order log reads", async () => {
    const route = await import("@/app/api/admin/wechat-order-logs/route");

    await expectUnauthenticated(await route.GET(new Request("http://localhost/api/admin/wechat-order-logs?limit=20")));

    expect(store.listWechatOrderLogs).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated wxauto MCP reads and writes before saving config", async () => {
    const route = await import("@/app/api/admin/wxauto-mcp/route");

    await expectUnauthenticated(await route.GET(new Request("http://localhost/api/admin/wxauto-mcp")));
    await expectUnauthenticated(await route.PUT(jsonRequest("http://localhost/api/admin/wxauto-mcp", "PUT", { enabled: true })));

    expect(store.getConfig).not.toHaveBeenCalled();
    expect(store.saveConfig).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated AI model discovery before reading config or calling providers", async () => {
    const route = await import("@/app/api/admin/ai-models/route");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expectUnauthenticated(await route.POST(jsonRequest("http://localhost/api/admin/ai-models", "POST", {
      endpoint: "https://api.example.com/v1/chat/completions",
      modelId: "fast"
    })));

    expect(store.getConfig).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
