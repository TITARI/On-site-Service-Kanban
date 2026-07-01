import { scryptSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import type {
  AccountCredential,
  AccountSession,
  AuthenticatedActor
} from "@/lib/domain/access-control";
import type { AppConfig } from "@/lib/seed";
import {
  adminLogin,
  bootstrapFirstAdmin,
  mobileLogin,
  resolveRequestActor
} from "@/lib/services/auth-service";
import { hashPassword } from "@/lib/services/password-service";
import { SESSION_COOKIE_NAMES, sessionTokenHash } from "@/lib/services/session-service";

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
    },
    {
      id: "builder",
      name: "Builder",
      description: "",
      canClaim: true,
      canProcess: true,
      canAccept: false,
      canAdmin: false,
      enabled: true
    },
    {
      id: "disabled",
      name: "Disabled",
      description: "",
      canClaim: false,
      canProcess: false,
      canAccept: true,
      canAdmin: false,
      enabled: false
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

function session(overrides: Partial<AccountSession> = {}): AccountSession {
  return {
    id: "session-1",
    accountId: "account-1",
    sessionType: "mobile",
    tokenHash: "a".repeat(64),
    authVersion: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-15T00:00:00.000Z",
    createdAt: "2026-06-15T00:00:00.000Z",
    ...overrides
  };
}

function credential(overrides: Partial<AccountCredential> = {}): AccountCredential {
  return {
    accountId: "account-admin",
    passwordHash: "",
    passwordChangedAt: "2026-01-01T00:00:00.000Z",
    mustChangePassword: false,
    failedAttempts: 0,
    ...overrides
  };
}

function legacyHash(password: string) {
  const salt = Buffer.alloc(16, 3);
  const key = scryptSync(password, salt, 64, {
    cost: 16384,
    blockSize: 8,
    parallelization: 1
  });
  return [
    "scrypt",
    16384,
    8,
    1,
    salt.toString("base64url"),
    key.toString("base64url")
  ].join("$");
}

function repository(overrides: Partial<AppRepository> = {}): AppRepository {
  return {
    kind: "file",
    getConfig: vi.fn(async () => config),
    upsertMobileAccount: vi.fn(async () => ({ actor: actor() })),
    createAccountSession: vi.fn(async (
      accountId: string,
      type,
      tokenHash: string,
      expiresAt: string
    ) => session({ accountId, sessionType: type, tokenHash, expiresAt })),
    resolveAccountSession: vi.fn(async () => undefined),
    ...overrides
  } as unknown as AppRepository;
}

describe("auth service", () => {
  it("transparently upgrades a legacy admin hash after successful login", async () => {
    const password = "StrongPass123!";
    const storedHash = legacyHash(password);
    const admin = actor({
      accountId: "account-admin",
      personId: "person-admin",
      sessionType: "admin",
      permissions: ["admin.access"]
    });
    const upgradeAdminPasswordHash = vi.fn(async () => true);
    const repo = repository({
      adminLoginRecord: vi.fn(async () => ({
        actor: admin,
        credential: credential({ passwordHash: storedHash })
      })),
      recordAdminLoginSuccess: vi.fn(async () => undefined),
      recordAdminLoginFailure: vi.fn(async () => undefined),
      upgradeAdminPasswordHash
    });

    await expect(adminLogin(repo, {
      phone: admin.phone,
      password
    })).resolves.toMatchObject({ actor: admin });

    expect(upgradeAdminPasswordHash).toHaveBeenCalledWith(
      admin.accountId,
      storedHash,
      expect.stringMatching(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    );
    expect(repo.createAccountSession).toHaveBeenCalledOnce();
  });

  it("does not rehash a current Argon2id credential or an invalid password", async () => {
    const password = "StrongPass123!";
    const currentHash = await hashPassword(password);
    const admin = actor({ sessionType: "admin", permissions: ["admin.access"] });
    const upgradeAdminPasswordHash = vi.fn(async () => true);
    const repo = repository({
      adminLoginRecord: vi.fn(async () => ({
        actor: admin,
        credential: credential({
          accountId: admin.accountId,
          passwordHash: currentHash
        })
      })),
      recordAdminLoginSuccess: vi.fn(async () => undefined),
      recordAdminLoginFailure: vi.fn(async () => undefined),
      upgradeAdminPasswordHash
    });

    await expect(adminLogin(repo, {
      phone: admin.phone,
      password
    })).resolves.toMatchObject({ actor: admin });
    expect(upgradeAdminPasswordHash).not.toHaveBeenCalled();

    await expect(adminLogin(repo, {
      phone: admin.phone,
      password: "WrongPass123!"
    })).rejects.toMatchObject({ status: 401 });
    expect(upgradeAdminPasswordHash).not.toHaveBeenCalled();
  });

  it("logs a rehash storage error without blocking a successful login", async () => {
    const password = "StrongPass123!";
    const storedHash = legacyHash(password);
    const admin = actor({ sessionType: "admin", permissions: ["admin.access"] });
    const failure = new Error("password hash CAS unavailable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repo = repository({
      adminLoginRecord: vi.fn(async () => ({
        actor: admin,
        credential: credential({
          accountId: admin.accountId,
          passwordHash: storedHash
        })
      })),
      recordAdminLoginSuccess: vi.fn(async () => undefined),
      recordAdminLoginFailure: vi.fn(async () => undefined),
      upgradeAdminPasswordHash: vi.fn(async () => { throw failure; })
    });

    try {
      await expect(adminLogin(repo, {
        phone: admin.phone,
        password
      })).resolves.toMatchObject({ actor: admin });

      expect(warn).toHaveBeenCalledWith(
        "[auth] password hash transparent upgrade failed",
        { accountId: admin.accountId, error: failure }
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(password);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(storedHash);
      expect(repo.createAccountSession).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("logs in a mobile user with normalized phone and a seven-day hashed session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T08:00:00.000Z"));
    const repo = repository();

    try {
      const result = await mobileLogin(repo, {
        name: " Alice ",
        phone: "138 0013 8000",
        groupId: "business"
      });

      expect(result.actor).toMatchObject({
        accountId: "account-1",
        phone: "13800138000",
        groupId: "business"
      });
      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.expiresAt.toISOString()).toBe("2026-06-22T08:00:00.000Z");
      expect(repo.upsertMobileAccount).toHaveBeenCalledWith({
        name: "Alice",
        phone: "13800138000",
        groupId: "business"
      });
      expect(repo.createAccountSession).toHaveBeenCalledWith(
        "account-1",
        "mobile",
        sessionTokenHash(result.token),
        "2026-06-22T08:00:00.000Z"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("bootstraps the first admin through one atomic repository session operation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T08:00:00.000Z"));
    const adminActor = actor({
      accountId: "account-admin",
      personId: "person-admin",
      name: "Root Admin",
      phone: "13700137000",
      groupId: "admin",
      groupName: "Administrators",
      permissions: ["admin.access"],
      sessionType: "admin"
    });
    const repo = repository({
      bootstrapStatus: vi.fn(async () => ({ required: true })),
      bootstrapAdmin: vi.fn(async () => adminActor),
      bootstrapAdminWithSession: vi.fn(async () => ({
        actor: adminActor,
        session: session({ accountId: adminActor.accountId, sessionType: "admin" })
      })),
      createAccountSession: vi.fn(async (
        accountId: string,
        type,
        tokenHash: string,
        expiresAt: string
      ) => session({ accountId, sessionType: type, tokenHash, expiresAt }))
    } as Partial<AppRepository>);
    const input = {
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing" as const, groupId: "admin" }
    };

    try {
      const result = await bootstrapFirstAdmin(
        repo,
        input,
        { ...process.env, ADMIN_BOOTSTRAP_PASSWORD: "legacy-secret" }
      );

      expect(result.actor).toBe(adminActor);
      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.expiresAt.toISOString()).toBe("2026-06-16T08:00:00.000Z");
      expect((repo as unknown as {
        bootstrapAdminWithSession: ReturnType<typeof vi.fn>;
      }).bootstrapAdminWithSession).toHaveBeenCalledWith(
        input,
        sessionTokenHash(result.token),
        "2026-06-16T08:00:00.000Z"
      );
      expect(repo.bootstrapAdmin).not.toHaveBeenCalled();
      expect(repo.createAccountSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires an explicit bootstrap password in production", async () => {
    const bootstrapAdminWithSession = vi.fn();
    const repo = repository({
      bootstrapStatus: vi.fn(async () => ({ required: true })),
      bootstrapAdminWithSession
    } as Partial<AppRepository>);
    const input = {
      legacyPassword: "admin123",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing" as const, groupId: "admin" }
    };

    await expect(bootstrapFirstAdmin(
      repo,
      input,
      { NODE_ENV: "production" } as NodeJS.ProcessEnv
    )).rejects.toThrow("ADMIN_BOOTSTRAP_PASSWORD is required in production.");

    expect(bootstrapAdminWithSession).not.toHaveBeenCalled();
  });

  it("rejects invalid mobile phone numbers before writing account state", async () => {
    const repo = repository();

    await expect(mobileLogin(repo, {
      name: "Alice",
      phone: "12345",
      groupId: "business"
    })).rejects.toMatchObject({ status: 400 });

    expect(repo.upsertMobileAccount).not.toHaveBeenCalled();
    expect(repo.createAccountSession).not.toHaveBeenCalled();
  });

  it("requires the submitted group to exist and be enabled", async () => {
    const repo = repository();

    await expect(mobileLogin(repo, {
      name: "Alice",
      phone: "13800138000",
      groupId: "disabled"
    })).rejects.toMatchObject({ status: 400 });

    await expect(mobileLogin(repo, {
      name: "Alice",
      phone: "13800138000",
      groupId: "missing"
    })).rejects.toMatchObject({ status: 400 });

    expect(repo.upsertMobileAccount).not.toHaveBeenCalled();
  });

  it("returns the repository actor unchanged when a locked account keeps its group", async () => {
    const lockedActor = actor({
      groupId: "builder",
      groupName: "Builder",
      permissions: ["ticket.claim", "ticket.process"]
    });
    const repo = repository({
      upsertMobileAccount: vi.fn(async () => ({ actor: lockedActor }))
    });

    const result = await mobileLogin(repo, {
      name: "Alice",
      phone: "13800138000",
      groupId: "business"
    });

    expect(result.actor).toBe(lockedActor);
    expect(repo.upsertMobileAccount).toHaveBeenCalledWith({
      name: "Alice",
      phone: "13800138000",
      groupId: "business"
    });
  });

  it("resolves a request actor from the session cookie", async () => {
    const token = Buffer.alloc(32, 1).toString("base64url");
    const expectedActor = actor({ permissions: ["ticket.process"] });
    const repo = repository({
      resolveAccountSession: vi.fn(async () => ({
        session: session({ tokenHash: sessionTokenHash(token) }),
        actor: expectedActor
      }))
    });
    const request = new Request("https://board.example/api/auth/session", {
      headers: { Cookie: `${SESSION_COOKIE_NAMES.mobile}=${token}` }
    });

    await expect(resolveRequestActor(repo, request, "mobile", "ticket.process"))
      .resolves.toBe(expectedActor);
    expect(repo.resolveAccountSession).toHaveBeenCalledWith(
      sessionTokenHash(token),
      "mobile"
    );
  });

  it("also supports resolving actors with the request-first route helper signature", async () => {
    const token = Buffer.alloc(32, 5).toString("base64url");
    const expectedActor = actor({ permissions: ["ticket.accept"] });
    const repo = repository({
      resolveAccountSession: vi.fn(async () => ({
        session: session({ tokenHash: sessionTokenHash(token) }),
        actor: expectedActor
      }))
    });
    vi.doMock("@/lib/repositories/app-repository", () => ({
      getAppRepository: () => repo
    }));
    vi.resetModules();
    const { resolveRequestActor: resolveWithDefaultRepository } =
      await import("@/lib/services/auth-service");
    const request = new Request("https://board.example/api/auth/session", {
      headers: { Cookie: `${SESSION_COOKIE_NAMES.mobile}=${token}` }
    });

    await expect(resolveWithDefaultRepository(request, "mobile", "ticket.accept"))
      .resolves.toBe(expectedActor);
    expect(repo.resolveAccountSession).toHaveBeenCalledWith(
      sessionTokenHash(token),
      "mobile"
    );
  });

  it("throws typed auth errors for missing or insufficient sessions", async () => {
    const token = Buffer.alloc(32, 2).toString("base64url");
    const repo = repository({
      resolveAccountSession: vi.fn(async () => ({
        session: session({ tokenHash: sessionTokenHash(token) }),
        actor: actor({ permissions: ["ticket.accept"] })
      }))
    });

    await expect(resolveRequestActor(
      repo,
      new Request("https://board.example/api/auth/session"),
      "mobile"
    )).rejects.toMatchObject({ status: 401 });

    await expect(resolveRequestActor(
      repo,
      new Request("https://board.example/api/auth/session", {
        headers: { Cookie: `${SESSION_COOKIE_NAMES.mobile}=${token}` }
      }),
      "mobile",
      "ticket.process"
    )).rejects.toMatchObject({ status: 403 });
  });
});
