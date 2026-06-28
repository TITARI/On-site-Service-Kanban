import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import type {
  AccountCredential,
  AccountSession,
  AuthenticatedActor,
  BootstrapAdminInput,
  SessionType
} from "@/lib/domain/access-control";
import { hashPassword } from "@/lib/services/password-service";
import {
  SESSION_COOKIE_NAMES,
  sessionTokenHash
} from "@/lib/services/session-service";

const store = vi.hoisted(() => ({
  bootstrapStatus: vi.fn(),
  bootstrapAdmin: vi.fn(),
  bootstrapAdminWithSession: vi.fn(),
  adminLoginRecord: vi.fn(),
  recordAdminLoginFailure: vi.fn(),
  recordAdminLoginSuccess: vi.fn(),
  resetExpiredAdminLock: vi.fn(),
  createAccountSession: vi.fn(),
  resolveAccountSession: vi.fn(),
  revokeAccountSession: vi.fn(),
  checkRateLimit: vi.fn(),
  resetRateLimit: vi.fn()
}));

const passwordMocks = vi.hoisted(() => ({
  verifyPassword: vi.fn()
}));

vi.mock("@/lib/services/password-service", async (importActual) => {
  const actual = await importActual();
  passwordMocks.verifyPassword.mockImplementation(actual.verifyPassword);
  return { ...actual, verifyPassword: passwordMocks.verifyPassword };
});

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "file",
    bootstrapStatus: store.bootstrapStatus,
    bootstrapAdmin: store.bootstrapAdmin,
    bootstrapAdminWithSession: store.bootstrapAdminWithSession,
    adminLoginRecord: store.adminLoginRecord,
    recordAdminLoginFailure: store.recordAdminLoginFailure,
    recordAdminLoginSuccess: store.recordAdminLoginSuccess,
    resetExpiredAdminLock: store.resetExpiredAdminLock,
    createAccountSession: store.createAccountSession,
    resolveAccountSession: store.resolveAccountSession,
    revokeAccountSession: store.revokeAccountSession,
    getRateLimiter: () => ({
      checkAndIncrement: store.checkRateLimit,
      reset: store.resetRateLimit
    })
  } as unknown as AppRepository)
}));

function actor(overrides: Partial<AuthenticatedActor> = {}): AuthenticatedActor {
  return {
    accountId: "account-admin",
    personId: "person-admin",
    name: "Admin",
    phone: "13800138000",
    groupId: "admins",
    groupName: "Administrators",
    permissions: ["admin.access"],
    sessionType: "admin",
    ...overrides
  };
}

function session(
  tokenHash: string,
  type: SessionType = "admin"
): AccountSession {
  return {
    id: "session-admin",
    accountId: "account-admin",
    sessionType: type,
    tokenHash,
    authVersion: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-15T00:00:00.000Z",
    createdAt: "2026-06-15T00:00:00.000Z"
  };
}

function jsonRequest(
  url: string,
  body: unknown,
  cookie?: string,
  headers?: Record<string, string>
) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: JSON.stringify(body)
  });
}

function bootstrapBody(overrides: Partial<BootstrapAdminInput> = {}) {
  return {
    legacyPassword: "legacy-secret",
    name: "Admin",
    phone: "13800138000",
    password: "new-password-123",
    group: { mode: "create" as const, name: "Administrators" },
    ...overrides
  };
}

function credential(overrides: Partial<AccountCredential> = {}): AccountCredential {
  return {
    accountId: "account-admin",
    passwordHash: "",
    passwordChangedAt: "2026-06-15T00:00:00.000Z",
    mustChangePassword: false,
    failedAttempts: 0,
    ...overrides
  };
}

describe("admin auth routes", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
    passwordMocks.verifyPassword.mockClear();
    store.bootstrapStatus.mockReset();
    store.bootstrapAdmin.mockReset();
    store.bootstrapAdminWithSession.mockReset();
    store.adminLoginRecord.mockReset();
    store.recordAdminLoginFailure.mockReset();
    store.recordAdminLoginSuccess.mockReset();
    store.resetExpiredAdminLock.mockReset();
    store.createAccountSession.mockReset();
    store.resolveAccountSession.mockReset();
    store.revokeAccountSession.mockReset();
    store.checkRateLimit.mockReset();
    store.resetRateLimit.mockReset();

    store.bootstrapStatus.mockResolvedValue({ required: true });
    store.bootstrapAdmin.mockResolvedValue(actor());
    store.bootstrapAdminWithSession.mockResolvedValue({ actor: actor() });
    store.createAccountSession.mockImplementation(async (
      accountId: string,
      type: SessionType,
      tokenHash: string
    ) => session(tokenHash, type));
    store.resolveAccountSession.mockResolvedValue(undefined);
    store.recordAdminLoginFailure.mockResolvedValue(undefined);
    store.recordAdminLoginSuccess.mockResolvedValue(undefined);
    store.resetExpiredAdminLock.mockResolvedValue(undefined);
    store.revokeAccountSession.mockResolvedValue(undefined);
    store.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    store.resetRateLimit.mockResolvedValue(undefined);
  });

  it("bootstraps the first admin with the server-only legacy password and sets an admin cookie", async () => {
    vi.stubEnv("ADMIN_BOOTSTRAP_PASSWORD", "legacy-secret");
    const route = await import("@/app/api/admin/auth/bootstrap/route");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/admin/auth/bootstrap",
      bootstrapBody()
    ));
    const payload = await response.json();
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(payload.user).toMatchObject({
      id: "person-admin",
      name: "Admin",
      phone: "13800138000",
      role: "admin"
    });
    expect(store.bootstrapStatus).toHaveBeenCalledOnce();
    expect(store.bootstrapAdminWithSession).toHaveBeenCalledWith(
      bootstrapBody(),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^20\d\d-/)
    );
    expect(store.bootstrapAdmin).not.toHaveBeenCalled();
    expect(store.createAccountSession).not.toHaveBeenCalled();
    expect(cookie).toContain(`${SESSION_COOKIE_NAMES.admin}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(store.resetRateLimit).toHaveBeenCalledWith("unknown");
  });

  it("allows admin123 as the non-production compatibility bootstrap password when no env override is set", async () => {
    const route = await import("@/app/api/admin/auth/bootstrap/route");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/admin/auth/bootstrap",
      bootstrapBody({ legacyPassword: "admin123" })
    ));

    expect(response.status).toBe(200);
    expect(store.bootstrapAdminWithSession).toHaveBeenCalledWith(
      bootstrapBody({ legacyPassword: "admin123" }),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^20\d\d-/)
    );
  });

  it("uses a larger shared bootstrap quota when the client IP is unknown", async () => {
    vi.stubEnv("ADMIN_BOOTSTRAP_PASSWORD", "legacy-secret");
    const route = await import("@/app/api/admin/auth/bootstrap/route");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/admin/auth/bootstrap",
      bootstrapBody()
    ));

    expect(response.status).toBe(200);
    expect(store.checkRateLimit).toHaveBeenCalledWith("unknown", 50, 15 * 60 * 1000);
  });

  it("keeps the standard bootstrap quota for a known client IP", async () => {
    vi.stubEnv("ADMIN_BOOTSTRAP_PASSWORD", "legacy-secret");
    const route = await import("@/app/api/admin/auth/bootstrap/route");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/admin/auth/bootstrap",
      bootstrapBody(),
      undefined,
      { "x-real-ip": "203.0.113.30" }
    ));

    expect(response.status).toBe(200);
    expect(store.checkRateLimit).toHaveBeenCalledWith("203.0.113.30", 5, 15 * 60 * 1000);
  });

  it("rate-limits repeated first-admin bootstrap attempts from the same client", async () => {
    vi.stubEnv("ADMIN_BOOTSTRAP_PASSWORD", "legacy-secret");
    let attempts = 0;
    store.checkRateLimit.mockImplementation(async () => {
      attempts += 1;
      return {
        allowed: attempts <= 5,
        remaining: Math.max(0, 5 - attempts)
      };
    });
    const route = await import("@/app/api/admin/auth/bootstrap/route");
    const request = () => jsonRequest(
      "https://board.example/api/admin/auth/bootstrap",
      bootstrapBody({ legacyPassword: "wrong-secret" }),
      undefined,
      { "x-forwarded-for": "203.0.113.10, 10.0.0.1" }
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await route.POST(request());
      expect(response.status).toBe(401);
    }
    const limited = await route.POST(request());
    const payload = await limited.json();

    expect(limited.status).toBe(429);
    expect(payload.message).toBe("初始化尝试过于频繁，请稍后再试");
    expect(store.checkRateLimit).toHaveBeenCalledTimes(6);
    expect(store.bootstrapStatus).toHaveBeenCalledTimes(5);
    expect(store.bootstrapAdminWithSession).not.toHaveBeenCalled();
  });

  it("shares bootstrap rate-limit attempts across worker module instances", async () => {
    vi.stubEnv("ADMIN_BOOTSTRAP_PASSWORD", "legacy-secret");
    let attempts = 0;
    store.checkRateLimit.mockImplementation(async () => {
      attempts += 1;
      return {
        allowed: attempts <= 5,
        remaining: Math.max(0, 5 - attempts)
      };
    });
    const request = () => jsonRequest(
      "https://board.example/api/admin/auth/bootstrap",
      bootstrapBody({ legacyPassword: "wrong-secret" }),
      undefined,
      { "x-forwarded-for": "203.0.113.20" }
    );

    const firstWorker = await import("@/app/api/admin/auth/bootstrap/route");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await firstWorker.POST(request())).status).toBe(401);
    }

    vi.resetModules();
    const secondWorker = await import("@/app/api/admin/auth/bootstrap/route");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await secondWorker.POST(request())).status).toBe(401);
    }
    expect((await secondWorker.POST(request())).status).toBe(429);
    expect(store.checkRateLimit).toHaveBeenCalledTimes(6);
  });

  it("rejects bootstrap after completion without creating an admin", async () => {
    vi.stubEnv("ADMIN_BOOTSTRAP_PASSWORD", "legacy-secret");
    store.bootstrapStatus.mockResolvedValue({ required: false });
    const route = await import("@/app/api/admin/auth/bootstrap/route");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/admin/auth/bootstrap",
      bootstrapBody()
    ));
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.message).toEqual(expect.any(String));
    expect(store.bootstrapAdmin).not.toHaveBeenCalled();
    expect(store.bootstrapAdminWithSession).not.toHaveBeenCalled();
    expect(store.createAccountSession).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects an incorrect legacy bootstrap password before repository bootstrap", async () => {
    vi.stubEnv("ADMIN_BOOTSTRAP_PASSWORD", "legacy-secret");
    const route = await import("@/app/api/admin/auth/bootstrap/route");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/admin/auth/bootstrap",
      bootstrapBody({ legacyPassword: "wrong-secret" })
    ));
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.message).toEqual(expect.any(String));
    expect(store.bootstrapAdmin).not.toHaveBeenCalled();
    expect(store.bootstrapAdminWithSession).not.toHaveBeenCalled();
  });

  it("logs in an enabled admin, resets failures, and sets the admin session cookie", async () => {
    const passwordHash = await hashPassword("correct-password");
    store.bootstrapStatus.mockResolvedValue({ required: false });
    store.adminLoginRecord.mockResolvedValue({
      actor: actor(),
      credential: credential({ passwordHash, failedAttempts: 2 })
    });
    const route = await import("@/app/api/admin/auth/login/route");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/admin/auth/login",
      { phone: "138 0013 8000", password: "correct-password" }
    ));
    const payload = await response.json();
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(payload.user).toMatchObject({ role: "admin", phone: "13800138000" });
    expect(store.adminLoginRecord).toHaveBeenCalledWith("13800138000");
    expect(store.recordAdminLoginSuccess).toHaveBeenCalledWith("account-admin");
    expect(store.recordAdminLoginFailure).not.toHaveBeenCalled();
    expect(store.createAccountSession).toHaveBeenCalledWith(
      "account-admin",
      "admin",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^20\d\d-/)
    );
    expect(cookie).toContain(`${SESSION_COOKIE_NAMES.admin}=`);
    expect(cookie).toContain("HttpOnly");
  });

  it("uses one generic password error for missing users and wrong passwords", async () => {
    const route = await import("@/app/api/admin/auth/login/route");

    store.adminLoginRecord.mockResolvedValueOnce(undefined);
    const missingResponse = await route.POST(jsonRequest(
      "https://board.example/api/admin/auth/login",
      { phone: "13800138000", password: "wrong-password" }
    ));
    const missingPayload = await missingResponse.json();

    const passwordHash = await hashPassword("correct-password");
    store.adminLoginRecord.mockResolvedValueOnce({
      actor: actor(),
      credential: credential({ passwordHash, failedAttempts: 0 })
    });
    const wrongResponse = await route.POST(jsonRequest(
      "https://board.example/api/admin/auth/login",
      { phone: "13800138000", password: "wrong-password" }
    ));
    const wrongPayload = await wrongResponse.json();

    expect(missingResponse.status).toBe(401);
    expect(wrongResponse.status).toBe(401);
    expect(wrongPayload.message).toBe(missingPayload.message);
    expect(store.recordAdminLoginFailure).toHaveBeenCalledWith(
      "account-admin",
      undefined
    );
  });

  it("locks an admin account for fifteen minutes after the fifth consecutive failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T08:00:00.000Z"));
    const passwordHash = await hashPassword("correct-password");
    store.adminLoginRecord.mockResolvedValue({
      actor: actor(),
      credential: credential({ passwordHash, failedAttempts: 4 })
    });
    const route = await import("@/app/api/admin/auth/login/route");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/admin/auth/login",
      { phone: "13800138000", password: "wrong-password" }
    ));

    expect(response.status).toBe(401);
    expect(store.recordAdminLoginFailure).toHaveBeenCalledWith(
      "account-admin",
      "2026-06-15T08:15:00.000Z"
    );
  });

  it("rejects logins during a non-expired lockout without checking the password", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T08:00:00.000Z"));
    const passwordHash = await hashPassword("correct-password");
    store.adminLoginRecord.mockResolvedValue({
      actor: actor(),
      credential: credential({
        passwordHash,
        failedAttempts: 5,
        lockedUntil: "2026-06-15T08:10:00.000Z"
      })
    });
    const route = await import("@/app/api/admin/auth/login/route");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/admin/auth/login",
      { phone: "13800138000", password: "correct-password" }
    ));
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.message).toEqual(expect.any(String));
    expect(store.recordAdminLoginSuccess).not.toHaveBeenCalled();
    expect(store.recordAdminLoginFailure).not.toHaveBeenCalled();
    expect(store.createAccountSession).not.toHaveBeenCalled();
  });

  it("returns the authenticated admin session payload from the shared session route", async () => {
    const token = Buffer.alloc(32, 8).toString("base64url");
    store.resolveAccountSession.mockResolvedValue({
      session: session(sessionTokenHash(token)),
      actor: actor()
    });
    const route = await import("@/app/api/auth/session/route");

    const response = await route.GET(new Request("https://board.example/api/auth/session?type=admin", {
      headers: { Cookie: `${SESSION_COOKIE_NAMES.admin}=${token}` }
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      authenticated: true,
      user: {
        id: "person-admin",
        role: "admin",
        phone: "13800138000"
      }
    });
    expect(store.resolveAccountSession).toHaveBeenCalledWith(
      sessionTokenHash(token),
      "admin"
    );
  });

  it("returns bootstrap status instead of 401 for a missing admin session", async () => {
    store.bootstrapStatus.mockResolvedValue({ required: true });
    const route = await import("@/app/api/auth/session/route");

    const response = await route.GET(new Request("https://board.example/api/auth/session?type=admin"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      authenticated: false,
      bootstrapRequired: true
    });
  });

  it("revokes the current admin session and expires the cookie", async () => {
    const route = await import("@/app/api/admin/auth/logout/route");
    const token = Buffer.alloc(32, 9).toString("base64url");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/admin/auth/logout",
      {},
      `${SESSION_COOKIE_NAMES.admin}=${token}`
    ));
    const payload = await response.json();
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true });
    expect(store.revokeAccountSession).toHaveBeenCalledWith(sessionTokenHash(token));
    expect(cookie).toContain(`${SESSION_COOKIE_NAMES.admin}=`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
  });

  it("resets the failure counter when a lockout window has expired before re-locking", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T09:00:00.000Z"));
    const passwordHash = await hashPassword("correct-password");
    store.bootstrapStatus.mockResolvedValue({ required: false });
    store.adminLoginRecord.mockResolvedValue({
      actor: actor(),
      credential: credential({
        passwordHash,
        failedAttempts: 5,
        lockedUntil: "2026-06-15T08:15:00.000Z"
      })
    });
    const route = await import("@/app/api/admin/auth/login/route");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/admin/auth/login",
      { phone: "13800138000", password: "wrong-password" }
    ));

    expect(response.status).toBe(401);
    expect(store.resetExpiredAdminLock).toHaveBeenCalledWith("account-admin");
    expect(store.recordAdminLoginFailure).toHaveBeenCalledWith("account-admin", undefined);
  });

  it("runs a dummy password verification for a non-existent account to equalize timing", async () => {
    vi.useRealTimers();
    store.bootstrapStatus.mockResolvedValue({ required: false });
    store.adminLoginRecord.mockResolvedValue(undefined);
    const route = await import("@/app/api/admin/auth/login/route");

    const response = await route.POST(jsonRequest(
      "https://board.example/api/admin/auth/login",
      { phone: "13800138000", password: "wrong-password" }
    ));

    expect(response.status).toBe(401);
    expect(passwordMocks.verifyPassword).toHaveBeenCalledTimes(1);
    expect(store.recordAdminLoginFailure).not.toHaveBeenCalled();
  });
});
