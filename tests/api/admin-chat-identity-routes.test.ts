import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";

const store = vi.hoisted(() => ({
  resolveAccountSession: vi.fn(),
  getUser: vi.fn(),
  listChatIdentities: vi.fn(),
  getChatIdentity: vi.fn(),
  identityByExternalId: vi.fn(),
  bindChatIdentity: vi.fn(),
  unbindChatIdentity: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => store as unknown as AppRepository
}));

const identitiesRoute = await import("@/app/api/admin/chat-identities/route");
const bindingRoute = await import("@/app/api/admin/users/[userId]/chat-identities/[platform]/route");

const actor = {
  accountId: "account-admin",
  personId: "person-admin",
  name: "Root Admin",
  phone: "13700137000",
  groupId: "admin",
  groupName: "Administrators",
  permissions: ["admin.access"] as const,
  sessionType: "admin" as const
};

const targetUser = {
  personId: "person-1",
  accountId: "account-1",
  name: "张三",
  phone: "13800138000",
  groupId: "builder",
  groupName: "搭建组",
  groupLocked: false,
  enabled: true,
  permissions: [],
  hasPassword: false,
  identities: {},
  updatedAt: "2026-06-12T00:00:00.000Z"
};

const occupied = {
  id: "identity-1",
  platform: "wechat" as const,
  externalUserId: "wxid-occupied",
  displayName: "李四微信",
  personId: "person-other",
  personName: "李四",
  personPhone: "13900139000",
  isTemporary: false,
  firstSeenAt: "2026-06-10T00:00:00.000Z",
  lastSeenAt: "2026-06-12T00:00:00.000Z"
};

function request(url: string, init?: RequestInit) {
  return new Request(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: `board_admin_session=${"A".repeat(43)}`,
      ...init?.headers
    }
  });
}

beforeEach(() => {
  Object.values(store).forEach((mock) => mock.mockReset());
  store.resolveAccountSession.mockResolvedValue({
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
  store.getUser.mockResolvedValue(targetUser);
  store.listChatIdentities.mockResolvedValue([occupied]);
  store.getChatIdentity.mockResolvedValue(occupied);
  store.identityByExternalId.mockResolvedValue(occupied);
  store.bindChatIdentity.mockResolvedValue({
    ...targetUser,
    identities: {
      wechat: {
        id: occupied.id,
        externalUserId: occupied.externalUserId,
        displayName: occupied.displayName
      }
    }
  });
  store.unbindChatIdentity.mockResolvedValue(targetUser);
  process.env.AUTH_CONFIRMATION_SECRET = "route-test-confirmation-secret";
});

describe("admin chat identity routes", () => {
  it("lists discovered stable identities", async () => {
    const response = await identitiesRoute.GET(request(
      "http://localhost/api/admin/chat-identities?platform=wechat"
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ identities: [occupied] });
  });

  it("returns a conflict token and accepts an explicitly confirmed rebind", async () => {
    const context = {
      params: Promise.resolve({ userId: "person-1", platform: "wechat" })
    };
    const first = await bindingRoute.PUT(request(
      "http://localhost/api/admin/users/person-1/chat-identities/wechat",
      {
        method: "PUT",
        body: JSON.stringify({ identityId: occupied.id })
      }
    ), context);

    expect(first.status).toBe(409);
    const conflict = await first.json() as { confirmationToken: string };
    expect(conflict.confirmationToken).toEqual(expect.any(String));

    const confirmed = await bindingRoute.PUT(request(
      "http://localhost/api/admin/users/person-1/chat-identities/wechat",
      {
        method: "PUT",
        body: JSON.stringify({
          identityId: occupied.id,
          confirmationToken: conflict.confirmationToken
        })
      }
    ), context);

    expect(confirmed.status).toBe(200);
    expect(store.bindChatIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmedRebindFromPersonId: "person-other"
      }),
      actor
    );
  });

  it("unbinds a platform identity and rejects unsupported platforms", async () => {
    const context = {
      params: Promise.resolve({ userId: "person-1", platform: "wecom" })
    };
    const response = await bindingRoute.DELETE(request(
      "http://localhost/api/admin/users/person-1/chat-identities/wecom",
      { method: "DELETE" }
    ), context);
    expect(response.status).toBe(200);
    expect(store.unbindChatIdentity).toHaveBeenCalledWith("person-1", "wecom", actor);

    const invalid = await bindingRoute.DELETE(request(
      "http://localhost/api/admin/users/person-1/chat-identities/email",
      { method: "DELETE" }
    ), {
      params: Promise.resolve({ userId: "person-1", platform: "email" })
    });
    expect(invalid.status).toBe(400);
  });
});
