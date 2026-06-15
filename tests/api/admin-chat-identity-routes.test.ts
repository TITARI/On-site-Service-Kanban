import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccountSession,
  AuthenticatedActor,
  UserListItem
} from "@/lib/domain/access-control";
import type { ChatIdentity } from "@/lib/domain/types";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { SESSION_COOKIE_NAMES, sessionTokenHash } from "@/lib/services/session-service";

const store = vi.hoisted(() => ({
  resolveAccountSession: vi.fn(),
  getUser: vi.fn(),
  listChatIdentities: vi.fn(),
  identityByExternalId: vi.fn(),
  bindChatIdentity: vi.fn(),
  unbindChatIdentity: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "file",
    resolveAccountSession: store.resolveAccountSession,
    getUser: store.getUser,
    listChatIdentities: store.listChatIdentities,
    identityByExternalId: store.identityByExternalId,
    bindChatIdentity: store.bindChatIdentity,
    unbindChatIdentity: store.unbindChatIdentity
  } as unknown as AppRepository)
}));

function actor(): AuthenticatedActor {
  return {
    accountId: "account-admin",
    personId: "person-admin",
    name: "Root Admin",
    phone: "13700137000",
    groupId: "admin",
    groupName: "Administrators",
    permissions: ["admin.access"],
    sessionType: "admin"
  };
}

function session(tokenHash: string): AccountSession {
  return {
    id: "session-admin",
    accountId: "account-admin",
    sessionType: "admin",
    tokenHash,
    authVersion: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-15T00:00:00.000Z",
    createdAt: "2026-06-15T00:00:00.000Z"
  };
}

function user(overrides: Partial<UserListItem> = {}): UserListItem {
  return {
    personId: "person-1",
    accountId: "account-person-1",
    name: "Alice",
    phone: "13800138000",
    groupId: "builder",
    groupName: "Builder",
    groupLocked: false,
    enabled: true,
    permissions: ["ticket.process"],
    hasPassword: false,
    identities: {},
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...overrides
  };
}

function identity(overrides: Partial<ChatIdentity> = {}): ChatIdentity {
  return {
    id: "identity-wxid-1",
    platform: "wechat",
    externalUserId: "wxid-1",
    displayName: "Alice WeChat",
    isTemporary: false,
    firstSeenAt: "2026-06-15T00:00:00.000Z",
    lastSeenAt: "2026-06-15T00:00:00.000Z",
    ...overrides
  };
}

const adminToken = Buffer.alloc(32, 7).toString("base64url");

function request(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      Cookie: `${SESSION_COOKIE_NAMES.admin}=${adminToken}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.resetModules();
  process.env.AUTH_CONFIRMATION_SECRET = "test-secret";
  for (const mock of Object.values(store)) mock.mockReset();
  store.resolveAccountSession.mockResolvedValue({
    session: session(sessionTokenHash(adminToken)),
    actor: actor()
  });
  store.getUser.mockResolvedValue(user());
  store.listChatIdentities.mockResolvedValue([identity()]);
  store.identityByExternalId.mockResolvedValue(identity());
  store.bindChatIdentity.mockResolvedValue(identity({ personId: "person-1" }));
  store.unbindChatIdentity.mockResolvedValue(undefined);
});

describe("admin chat identity routes", () => {
  it("lists discovered stable identities", async () => {
    const route = await import("@/app/api/admin/chat-identities/route");

    const response = await route.GET(request(
      "https://board.example/api/admin/chat-identities?platform=wechat",
      "GET"
    ));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(store.listChatIdentities).toHaveBeenCalledWith({
      platform: "wechat",
      stableOnly: true
    });
    expect(payload).toEqual({ identities: [identity()] });
  });

  it("returns conflict code and confirmation token when binding is occupied", async () => {
    store.identityByExternalId.mockResolvedValue(
      identity({ personId: "person-other" })
    );
    const route = await import("@/app/api/admin/users/[userId]/chat-identities/[platform]/route");

    const response = await route.PUT(request(
      "https://board.example/api/admin/users/person-1/chat-identities/wechat",
      "PUT",
      { externalUserId: "wxid-1", displayName: "Alice WeChat" }
    ), {
      params: Promise.resolve({ userId: "person-1", platform: "wechat" })
    });
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      code: "IDENTITY_CONFLICT",
      confirmationToken: expect.any(String)
    });
    expect(store.bindChatIdentity).not.toHaveBeenCalled();
  });

  it("unbinds a platform identity for a user", async () => {
    const route = await import("@/app/api/admin/users/[userId]/chat-identities/[platform]/route");

    const response = await route.DELETE(request(
      "https://board.example/api/admin/users/person-1/chat-identities/wechat",
      "DELETE"
    ), {
      params: Promise.resolve({ userId: "person-1", platform: "wechat" })
    });

    expect(response.status).toBe(204);
    expect(store.unbindChatIdentity).toHaveBeenCalledWith(
      { userId: "person-1", platform: "wechat" },
      actor()
    );
  });
});
