import { describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { defaultConfig } from "@/lib/seed";
import {
  adminLogin,
  bootstrapFirstAdmin,
  mobileLogin,
  resolveRequestActor
} from "@/lib/services/auth-service";
import { hashPassword } from "@/lib/services/password-service";

function actor(groupId = "builder") {
  return {
    accountId: "account-1",
    personId: "person-1",
    name: "张三",
    phone: "13800138000",
    groupId,
    groupName: groupId === "builder" ? "搭建组" : "业务组",
    permissions: ["ticket.process" as const],
    sessionType: "mobile" as const
  };
}

function repository(overrides: Partial<AppRepository> = {}) {
  return {
    getConfig: vi.fn(async () => defaultConfig()),
    upsertMobileAccount: vi.fn(async () => ({ actor: actor() })),
    createAccountSession: vi.fn(async (_accountId, type, tokenHash, expiresAt) => ({
      id: "session-1",
      accountId: "account-1",
      sessionType: type,
      tokenHash,
      authVersion: 1,
      expiresAt,
      lastSeenAt: "2026-06-12T00:00:00.000Z",
      createdAt: "2026-06-12T00:00:00.000Z"
    })),
    resolveAccountSession: vi.fn(),
    ...overrides
  } as unknown as AppRepository;
}

describe("auth service", () => {
  it("creates a seven-day mobile session and returns the server actor", async () => {
    const repo = repository({
      upsertMobileAccount: vi.fn(async () => ({ actor: actor("business") }))
    });
    const now = new Date("2026-06-12T00:00:00.000Z");

    const result = await mobileLogin(repo, {
      name: " 张三 ",
      phone: "138 0013 8000",
      groupId: "business"
    }, now);

    expect(result.actor.groupId).toBe("business");
    expect(result.cookie).toContain("board_mobile_session=");
    expect(result.cookie).toContain("HttpOnly");
    expect(repo.upsertMobileAccount).toHaveBeenCalledWith({
      name: "张三",
      phone: "13800138000",
      groupId: "business"
    });
    expect(repo.createAccountSession).toHaveBeenCalledWith(
      "account-1",
      "mobile",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "2026-06-19T00:00:00.000Z"
    );
  });

  it("returns the locked server group rather than the submitted group", async () => {
    const repo = repository({
      upsertMobileAccount: vi.fn(async () => ({ actor: actor("builder") }))
    });
    const result = await mobileLogin(repo, {
      name: "张三",
      phone: "13800138000",
      groupId: "business"
    });

    expect(result.actor.groupId).toBe("builder");
  });

  it("rejects invalid phones and disabled or missing groups", async () => {
    const repo = repository();
    await expect(mobileLogin(repo, {
      name: "张三",
      phone: "12345",
      groupId: "builder"
    })).rejects.toThrow("手机号格式不正确");

    await expect(mobileLogin(repo, {
      name: "张三",
      phone: "13800138000",
      groupId: "missing"
    })).rejects.toThrow("用户分组不存在或已停用");
  });

  it("resolves request cookies and distinguishes unauthenticated from forbidden", async () => {
    const repo = repository({
      resolveAccountSession: vi.fn(async () => ({
        actor: actor(),
        session: {
          id: "session-1",
          accountId: "account-1",
          sessionType: "mobile",
          tokenHash: "stored-hash",
          authVersion: 1,
          expiresAt: "2026-06-19T00:00:00.000Z",
          lastSeenAt: "2026-06-12T00:00:00.000Z",
          createdAt: "2026-06-12T00:00:00.000Z"
        }
      }))
    });
    const request = new Request("https://board.example", {
      headers: { cookie: `board_mobile_session=${"A".repeat(43)}` }
    });

    const allowed = await resolveRequestActor(repo, request, "mobile", "ticket.process");
    expect(allowed.ok).toBe(true);

    const forbidden = await resolveRequestActor(repo, request, "mobile", "ticket.accept");
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.response.status).toBe(403);

    const anonymous = await resolveRequestActor(
      repository({ resolveAccountSession: vi.fn(async () => undefined) }),
      new Request("https://board.example"),
      "mobile"
    );
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) expect(anonymous.response.status).toBe(401);
  });

  it("allows the legacy password only while bootstrap is incomplete", async () => {
    const adminActor = {
      ...actor(),
      permissions: ["admin.access" as const],
      sessionType: "admin" as const
    };
    const repo = repository({
      bootstrapStatus: vi.fn(async () => ({ required: true })),
      bootstrapAdmin: vi.fn(async () => adminActor)
    });
    const input = {
      legacyPassword: "admin123",
      name: "系统管理员",
      phone: "13800138000",
      password: "StrongPass123!",
      group: { mode: "create" as const, name: "系统管理员组" }
    };

    const result = await bootstrapFirstAdmin(
      repo,
      input,
      { ADMIN_BOOTSTRAP_PASSWORD: "admin123" },
      new Date("2026-06-12T00:00:00.000Z")
    );

    expect(result.actor.permissions).toContain("admin.access");
    expect(result.cookie).toContain("board_admin_session=");
    expect(repo.bootstrapAdmin).toHaveBeenCalledWith(input, {
      sessionType: "admin",
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expiresAt: "2026-06-12T12:00:00.000Z"
    });

    const completed = repository({
      bootstrapStatus: vi.fn(async () => ({ required: false }))
    });
    await expect(bootstrapFirstAdmin(completed, input, {})).rejects.toThrow("初始化已完成");
  });

  it("locks password login after five failures for fifteen minutes", async () => {
    const repo = repository({
      adminLoginRecord: vi.fn(async () => ({
        actor: {
          ...actor(),
          permissions: ["admin.access"],
          sessionType: "admin"
        },
        credential: {
          accountId: "account-1",
          passwordHash: await hashPassword("CorrectPass123!"),
          passwordChangedAt: "2026-06-11T00:00:00.000Z",
          mustChangePassword: false,
          failedAttempts: 4
        }
      })),
      recordAdminLoginFailure: vi.fn(async () => undefined)
    });

    await expect(adminLogin(
      repo,
      "13800138000",
      "wrong",
      new Date("2026-06-12T00:00:00.000Z")
    )).rejects.toThrow("手机号或密码不正确");

    expect(repo.recordAdminLoginFailure).toHaveBeenCalledWith(
      "account-1",
      "2026-06-12T00:15:00.000Z"
    );
  });

  it("creates an admin session after a valid password and rejects an active lock", async () => {
    const passwordHash = await hashPassword("CorrectPass123!");
    const loginRecord = {
      actor: {
        ...actor(),
        permissions: ["admin.access" as const],
        sessionType: "admin" as const
      },
      credential: {
        accountId: "account-1",
        passwordHash,
        passwordChangedAt: "2026-06-11T00:00:00.000Z",
        mustChangePassword: false,
        failedAttempts: 0
      }
    };
    const repo = repository({
      adminLoginRecord: vi.fn(async () => loginRecord),
      recordAdminLoginSuccess: vi.fn(async () => undefined)
    });

    const result = await adminLogin(
      repo,
      "138 0013 8000",
      "CorrectPass123!",
      new Date("2026-06-12T00:00:00.000Z")
    );

    expect(result.actor.sessionType).toBe("admin");
    expect(repo.recordAdminLoginSuccess).toHaveBeenCalledWith("account-1");
    expect(repo.createAccountSession).toHaveBeenCalledWith(
      "account-1",
      "admin",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "2026-06-12T12:00:00.000Z"
    );

    const locked = repository({
      adminLoginRecord: vi.fn(async () => ({
        ...loginRecord,
        credential: {
          ...loginRecord.credential,
          lockedUntil: "2026-06-12T00:10:00.000Z"
        }
      }))
    });
    await expect(adminLogin(
      locked,
      "13800138000",
      "CorrectPass123!",
      new Date("2026-06-12T00:00:00.000Z")
    )).rejects.toThrow("登录尝试过多，请稍后再试");
  });
});
