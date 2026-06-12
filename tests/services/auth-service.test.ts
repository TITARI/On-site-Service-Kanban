import { describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { defaultConfig } from "@/lib/seed";
import { mobileLogin, resolveRequestActor } from "@/lib/services/auth-service";

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
});
