import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type AppConfig } from "@/lib/seed";
import type { AppRepository } from "@/lib/repositories/app-repository";

const store = vi.hoisted(() => ({
  config: undefined as AppConfig | undefined,
  getConfig: vi.fn(),
  saveKeywordGroups: vi.fn(),
  listWechatOrderLogs: vi.fn(),
  resolveAccountSession: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    getConfig: store.getConfig,
    saveKeywordGroups: store.saveKeywordGroups,
    listWechatOrderLogs: store.listWechatOrderLogs,
    resolveAccountSession: store.resolveAccountSession
  } as unknown as AppRepository)
}));

const actor = {
  accountId: "account-admin",
  personId: "person-admin",
  name: "Admin",
  phone: "13800138000",
  groupId: "admin",
  groupName: "Administrators",
  permissions: ["admin.access"] as const,
  sessionType: "admin" as const
};

function adminRequest(url: string, init?: RequestInit) {
  return new Request(url, {
    ...init,
    headers: {
      cookie: `board_admin_session=${"A".repeat(43)}`,
      ...init?.headers
    }
  });
}

function freshConfig() {
  return defaultConfig();
}

describe("admin database-backed routes", () => {
  beforeEach(() => {
    store.config = freshConfig();
    store.getConfig.mockReset();
    store.saveKeywordGroups.mockReset();
    store.listWechatOrderLogs.mockReset();
    store.resolveAccountSession.mockReset().mockResolvedValue({
      actor,
      session: {
        id: "session-admin",
        accountId: actor.accountId,
        sessionType: "admin",
        tokenHash: "stored-hash",
        authVersion: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        lastSeenAt: "2026-06-12T00:00:00.000Z",
        createdAt: "2026-06-12T00:00:00.000Z"
      }
    });
    store.getConfig.mockImplementation(async () => store.config!);
    store.saveKeywordGroups.mockImplementation(async (keywordGroups) => {
      store.config = { ...store.config!, keywordGroups };
      return keywordGroups;
    });
  });

  it("reads and saves keyword groups through the repository", async () => {
    const route = await import("@/app/api/admin/keywords/route");
    const getResponse = await route.GET(adminRequest("http://localhost/api/admin/keywords"));
    await expect(getResponse.json()).resolves.toEqual({ keywordGroups: store.config!.keywordGroups });

    const nextKeywordGroups = [
      {
        id: "custom",
        name: "Custom",
        description: "Site keywords",
        enabled: true,
        rules: [
          {
            id: "custom-1",
            keyword: "coffee machine",
            matchType: "contains",
            action: "operational-intent",
            priority: 10,
            enabled: true
          }
        ]
      }
    ];

    const putResponse = await route.PUT(adminRequest("http://localhost/api/admin/keywords", {
      method: "PUT",
      body: JSON.stringify({ keywordGroups: nextKeywordGroups })
    }));

    await expect(putResponse.json()).resolves.toEqual({
      keywordGroups: [
        expect.objectContaining({
          id: "custom",
          ruleSets: [
            expect.objectContaining({
              matchType: "contains",
              action: "operational-intent",
              terms: [expect.objectContaining({ value: "coffee machine" })]
            })
          ]
        })
      ]
    });
    expect(store.config!.keywordGroups?.[0].ruleSets?.[0].terms[0].value).toBe("coffee machine");
    expect(store.saveKeywordGroups).toHaveBeenCalledOnce();
  });

  it("accepts keyword rule sets with multiple keyword terms", async () => {
    const route = await import("@/app/api/admin/keywords/route");
    const nextKeywordGroups = [
      {
        id: "site-intent",
        name: "Site requests",
        description: "Operational request keywords",
        enabled: true,
        ruleSets: [
          {
            id: "site-intent-report",
            matchType: "contains",
            action: "operational-intent",
            priority: 50,
            enabled: true,
            channels: ["wechat"],
            conditions: { identityGroups: ["builder"] },
            actionConfig: { autoCreateTicket: true },
            sortOrder: 1,
            terms: [
              { id: "term-repair", value: "repair", enabled: true, sortOrder: 1 },
              { id: "term-broken", value: "broken", enabled: true, aliases: ["not working"], sortOrder: 2 }
            ]
          }
        ]
      }
    ];

    const putResponse = await route.PUT(adminRequest("http://localhost/api/admin/keywords", {
      method: "PUT",
      body: JSON.stringify({ keywordGroups: nextKeywordGroups })
    }));

    await expect(putResponse.json()).resolves.toEqual({ keywordGroups: nextKeywordGroups });
    expect(store.config!.keywordGroups).toEqual(nextKeywordGroups);
    expect(store.saveKeywordGroups).toHaveBeenCalledWith(nextKeywordGroups);
  });

  it("returns WeChat order logs through the repository", async () => {
    store.listWechatOrderLogs.mockResolvedValue([
      {
        id: "log-1",
        inboundMessageId: "message-1",
        channel: "wechat",
        action: "create-ticket",
        ticketId: "ticket-1",
        summary: "ticket created",
        status: "processed",
        createdAt: "2026-05-29T12:00:00.000Z"
      }
    ]);

    const route = await import("@/app/api/admin/wechat-order-logs/route");
    const response = await route.GET(adminRequest("http://localhost/api/admin/wechat-order-logs?limit=20"));

    await expect(response.json()).resolves.toEqual({
      logs: [
        {
          id: "log-1",
          inboundMessageId: "message-1",
          channel: "wechat",
          action: "create-ticket",
          ticketId: "ticket-1",
          summary: "ticket created",
          status: "processed",
          createdAt: "2026-05-29T12:00:00.000Z"
        }
      ]
    });
    expect(store.listWechatOrderLogs).toHaveBeenCalledWith(20);
  });

  it("rejects admin data reads without an admin session", async () => {
    const route = await import("@/app/api/admin/keywords/route");
    const response = await route.GET(new Request("http://localhost/api/admin/keywords"));

    expect(response.status).toBe(401);
  });
});
