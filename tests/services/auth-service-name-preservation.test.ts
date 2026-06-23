import { describe, expect, it, vi } from "vitest";
import type { AppState } from "@/lib/domain/app-state";
import type { AppRepository } from "@/lib/repositories/app-repository";
import type { AuthenticatedActor } from "@/lib/domain/access-control";
import { upsertMobileAccountInState } from "@/lib/services/access-state-service";
import { mobileLogin } from "@/lib/services/auth-service";

function state(): AppState {
  return {
    booths: [],
    tickets: [],
    messageRecords: [],
    people: [],
    accounts: [],
    roles: [],
    accountRoles: [],
    rolePermissions: [],
    accountSessions: [],
    auditLogs: [],
    config: {
      issueTypes: [],
      aiModels: [],
      assignmentRules: [],
      userGroups: [
        { id: "business", name: "业务组", description: "", canClaim: false, canProcess: false, canAccept: true, canAdmin: false, enabled: true },
        { id: "builder", name: "搭建组", description: "", canClaim: true, canProcess: true, canAccept: false, canAdmin: false, enabled: true }
      ]
    }
  };
}

function actor(overrides: Partial<AuthenticatedActor> = {}): AuthenticatedActor {
  return {
    accountId: "account-1",
    personId: "person-1",
    name: "张三",
    phone: "13800138000",
    groupId: "business",
    groupName: "业务组",
    permissions: ["ticket.accept"],
    sessionType: "mobile",
    ...overrides
  };
}

describe("mobile login name preservation", () => {
  it("首次登录创建账号，使用请求者姓名", () => {
    const appState = state();

    upsertMobileAccountInState(appState, { name: " 张三 ", phone: "13800138000", groupId: "business" });

    expect(appState.people?.[0]).toMatchObject({
      name: "张三",
      phone: "13800138000",
      groupId: "business",
      groupName: "业务组"
    });
  });

  it("同手机号再次登录且姓名不同时保留既有 person.name", () => {
    const appState = state();
    upsertMobileAccountInState(appState, { name: "张三", phone: "13800138000", groupId: "business" });

    upsertMobileAccountInState(appState, { name: "冒名者", phone: "13800138000", groupId: "business" });

    expect(appState.people?.[0]?.name).toBe("张三");
  });

  it("同手机号再次登录且分组不同时更新分组并写审计", () => {
    const appState = state();
    upsertMobileAccountInState(appState, { name: "张三", phone: "13800138000", groupId: "business" });
    appState.auditLogs = [];

    upsertMobileAccountInState(appState, {
      name: "冒名者",
      phone: "13800138000",
      groupId: "builder",
      ip: "203.0.113.10"
    });

    expect(appState.people?.[0]).toMatchObject({
      name: "张三",
      phone: "13800138000",
      groupId: "builder",
      groupName: "搭建组"
    });
    expect(appState.auditLogs).toContainEqual(expect.objectContaining({
      action: "mobile_login_group_change",
      targetId: appState.people?.[0]?.id,
      detail: expect.objectContaining({
        fromGroupId: "business",
        toGroupId: "builder",
        fromGroupName: "业务组",
        toGroupName: "搭建组",
        ip: "203.0.113.10"
      })
    }));
  });

  it("新建账号审计含 IP", () => {
    const appState = state();

    upsertMobileAccountInState(appState, {
      name: "张三",
      phone: "13800138000",
      groupId: "business",
      ip: "203.0.113.20"
    });

    expect(appState.auditLogs).toContainEqual(expect.objectContaining({
      action: "mobile_account_created",
      targetId: appState.people?.[0]?.id,
      detail: expect.objectContaining({
        phone: "13800138000",
        name: "张三",
        groupId: "business",
        ip: "203.0.113.20"
      })
    }));
  });

  it("mobileLogin 传入请求 IP 用于审计追踪", async () => {
    const upsertMobileAccount = vi.fn(async () => ({ actor: actor() }));
    const repo = {
      getConfig: vi.fn(async () => state().config),
      upsertMobileAccount,
      createAccountSession: vi.fn(async (accountId, sessionType, tokenHash, expiresAt) => ({
        id: "session-1",
        accountId,
        sessionType,
        tokenHash,
        authVersion: 1,
        expiresAt,
        lastSeenAt: expiresAt,
        createdAt: expiresAt
      }))
    } as unknown as AppRepository;

    await mobileLogin(repo, {
      name: "张三",
      phone: "13800138000",
      groupId: "business"
    }, new Request("https://board.example/api/auth/mobile/login", {
      headers: { "x-forwarded-for": "203.0.113.30, 10.0.0.1" }
    }));

    expect(upsertMobileAccount).toHaveBeenCalledWith({
      name: "张三",
      phone: "13800138000",
      groupId: "business",
      ip: "203.0.113.30"
    });
  });
});
