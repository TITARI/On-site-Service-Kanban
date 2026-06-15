import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { defaultConfig } from "@/lib/seed";
import { SESSION_COOKIE_NAMES } from "@/lib/services/session-service";

const ADMIN_TOKEN = Buffer.alloc(32, 4).toString("base64url");

const store = vi.hoisted(() => ({
  config: undefined as ReturnType<typeof defaultConfig> | undefined,
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  resolveAccountSession: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "file",
    getConfig: store.getConfig,
    saveConfig: store.saveConfig,
    resolveAccountSession: store.resolveAccountSession
  } as unknown as AppRepository)
}));

const route = await import("@/app/api/admin/wxauto-mcp/route");

function get() {
  return new Request("http://localhost/api/admin/wxauto-mcp", {
    headers: { Cookie: `${SESSION_COOKIE_NAMES.admin}=${ADMIN_TOKEN}` }
  });
}

function put(body: unknown) {
  return new Request("http://localhost/api/admin/wxauto-mcp", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${SESSION_COOKIE_NAMES.admin}=${ADMIN_TOKEN}`
    },
    body: JSON.stringify(body)
  });
}

function adminSession() {
  return {
    actor: {
      accountId: "account-admin",
      personId: "person-admin",
      name: "Admin",
      phone: "13800138000",
      groupId: "group-admin",
      groupName: "Admins",
      permissions: ["admin.access"],
      sessionType: "admin"
    },
    session: {
      id: "session-admin",
      accountId: "account-admin",
      sessionType: "admin",
      tokenHash: "hash",
      authVersion: 1,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      lastSeenAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    }
  };
}

beforeEach(() => {
  store.config = defaultConfig();
  store.getConfig.mockReset().mockImplementation(async () => store.config!);
  store.saveConfig.mockReset().mockImplementation(async (config) => {
    store.config = config;
    return config;
  });
  store.resolveAccountSession.mockReset().mockResolvedValue(adminSession());
});

describe("/api/admin/wxauto-mcp", () => {
  it("starts the embedded MCP service and ensures it has a token when the admin page loads", async () => {
    const response = await route.GET(get());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.wxautoMcp.endpoint).toBe("/api/mcp");
    expect(body.wxautoMcp.enabled).toBe(true);
    expect(body.wxautoMcp.accessToken).toMatch(/^wxauto_/);
    expect(store.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      wxautoMcp: expect.objectContaining({ enabled: true, endpoint: "/api/mcp" }),
      messageIntegrations: expect.arrayContaining([
        expect.objectContaining({
          channel: "wechat",
          label: "wxauto 桌面服务",
          enabled: true,
          endpoint: "/api/mcp",
          secretEnv: "WXAUTO_MCP_TOKEN"
        })
      ])
    }));
  });

  it("saves enabled state, auto-create setting, and a manually entered token", async () => {
    const response = await route.PUT(put({
      enabled: true,
      autoCreateTickets: true,
      accessToken: "manual-token"
    }));

    expect(response.status).toBe(200);
    expect(store.config!.wxautoMcp).toMatchObject({
      enabled: true,
      accessToken: "manual-token",
      autoCreateTickets: true
    });
    expect(store.config!.messageIntegrations?.find((item) => item.channel === "wechat")).toMatchObject({
      enabled: true,
      endpoint: "/api/mcp",
      autoCreateTickets: true
    });
  });

  it("rotates the token on demand", async () => {
    store.config = { ...defaultConfig(), wxautoMcp: { enabled: true, endpoint: "/api/mcp", accessToken: "old-token", autoCreateTickets: false } };

    const response = await route.PUT(put({ rotateToken: true }));

    expect(response.status).toBe(200);
    expect(store.config!.wxautoMcp?.accessToken).toMatch(/^wxauto_/);
    expect(store.config!.wxautoMcp?.accessToken).not.toBe("old-token");
  });
});
