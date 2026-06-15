import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import type {
  AccountSession,
  AuthenticatedActor,
  SessionType
} from "@/lib/domain/access-control";
import { SESSION_COOKIE_NAMES, sessionTokenHash } from "@/lib/services/session-service";
import type { AppConfig } from "@/lib/seed";

const store = vi.hoisted(() => ({
  getConfig: vi.fn(),
  upsertMobileAccount: vi.fn(),
  createAccountSession: vi.fn(),
  resolveAccountSession: vi.fn(),
  revokeAccountSession: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "file",
    getConfig: store.getConfig,
    upsertMobileAccount: store.upsertMobileAccount,
    createAccountSession: store.createAccountSession,
    resolveAccountSession: store.resolveAccountSession,
    revokeAccountSession: store.revokeAccountSession
  } as unknown as AppRepository)
}));

const config: AppConfig = {
  issueTypes: [],
  aiModels: [],
  userGroups: [
    {
      id: "business",
      name: "Business",
      description: "",
      canClaim: false,
      canProcess: false,
      canAccept: true,
      canAdmin: false,
      enabled: true
    }
  ],
  assignmentRules: []
};

function actor(overrides: Partial<AuthenticatedActor> = {}): AuthenticatedActor {
  return {
    accountId: "account-1",
    personId: "person-1",
    name: "Alice",
    phone: "13800138000",
    groupId: "business",
    groupName: "Business",
    permissions: ["ticket.accept"],
    sessionType: "mobile",
    ...overrides
  };
}

function session(
  tokenHash: string,
  type: SessionType = "mobile"
): AccountSession {
  return {
    id: "session-1",
    accountId: "account-1",
    sessionType: type,
    tokenHash,
    authVersion: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-15T00:00:00.000Z",
    createdAt: "2026-06-15T00:00:00.000Z"
  };
}

function jsonRequest(url: string, body: unknown, cookie?: string) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: JSON.stringify(body)
  });
}

describe("mobile auth routes", () => {
  beforeEach(() => {
    store.getConfig.mockReset();
    store.upsertMobileAccount.mockReset();
    store.createAccountSession.mockReset();
    store.resolveAccountSession.mockReset();
    store.revokeAccountSession.mockReset();
    store.getConfig.mockResolvedValue(config);
    store.upsertMobileAccount.mockResolvedValue({ actor: actor() });
    store.createAccountSession.mockImplementation(async (
      accountId: string,
      type: SessionType,
      tokenHash: string,
      expiresAt: string
    ) => session(tokenHash, type));
    store.resolveAccountSession.mockResolvedValue(undefined);
    store.revokeAccountSession.mockResolvedValue(undefined);
  });

  it("logs in a mobile user, sets an HttpOnly cookie, and returns a user payload", async () => {
    const route = await import("@/app/api/auth/mobile/login/route");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/auth/mobile/login",
      { name: "Alice", phone: "13800138000", groupId: "business" }
    ));
    const payload = await response.json();
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(payload.user).toEqual({
      id: "person-1",
      name: "Alice",
      phone: "13800138000",
      role: "member",
      groupId: "business",
      groupName: "Business",
      permissions: {
        canClaim: false,
        canProcess: false,
        canAccept: true
      }
    });
    expect(cookie).toContain(`${SESSION_COOKIE_NAMES.mobile}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(store.createAccountSession).toHaveBeenCalledWith(
      "account-1",
      "mobile",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^20\d\d-/)
    );
  });

  it("returns a 400-ish response for invalid mobile login input", async () => {
    const route = await import("@/app/api/auth/mobile/login/route");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/auth/mobile/login",
      { name: "Alice", phone: "12345", groupId: "business" }
    ));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.message).toEqual(expect.any(String));
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(store.upsertMobileAccount).not.toHaveBeenCalled();
  });

  it("resolves the current mobile session from the cookie", async () => {
    const route = await import("@/app/api/auth/session/route");
    const token = Buffer.alloc(32, 3).toString("base64url");
    store.resolveAccountSession.mockResolvedValue({
      session: session(sessionTokenHash(token)),
      actor: actor({ permissions: ["ticket.claim", "ticket.process"] })
    });

    const response = await route.GET(new Request("https://board.example/api/auth/session?type=mobile", {
      headers: { Cookie: `${SESSION_COOKIE_NAMES.mobile}=${token}` }
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.user).toMatchObject({
      id: "person-1",
      groupId: "business",
      permissions: {
        canClaim: true,
        canProcess: true,
        canAccept: false
      }
    });
    expect(store.resolveAccountSession).toHaveBeenCalledWith(
      sessionTokenHash(token),
      "mobile"
    );
  });

  it("returns 401 when the mobile session is missing", async () => {
    const route = await import("@/app/api/auth/session/route");

    const response = await route.GET(new Request("https://board.example/api/auth/session?type=mobile"));
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.message).toEqual(expect.any(String));
  });

  it("revokes the current mobile session and expires the cookie", async () => {
    const route = await import("@/app/api/auth/mobile/logout/route");
    const token = Buffer.alloc(32, 4).toString("base64url");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/auth/mobile/logout",
      {},
      `${SESSION_COOKIE_NAMES.mobile}=${token}`
    ));
    const payload = await response.json();
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true });
    expect(store.revokeAccountSession).toHaveBeenCalledWith(sessionTokenHash(token));
    expect(cookie).toContain(`${SESSION_COOKIE_NAMES.mobile}=`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
  });

  it("expires the mobile cookie even when logout has no current session", async () => {
    const route = await import("@/app/api/auth/mobile/logout/route");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/auth/mobile/logout",
      {}
    ));
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(store.revokeAccountSession).not.toHaveBeenCalled();
    expect(cookie).toContain("Max-Age=0");
  });
});
