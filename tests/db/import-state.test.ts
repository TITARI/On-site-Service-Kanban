import { describe, expect, it } from "vitest";

describe("db import stable ids", () => {
  it("does not collide for long ids with the same prefix", async () => {
    const { stableId } = await import("../../scripts/db-import-state.mjs");

    const first = stableId("feedback", "ticket-fb63d144-5279-4587-8e67-3cda23558b2f:mobile-user");
    const second = stableId("feedback", "ticket-fb63d144-5279-4587-8e67-3cda23558b2f:smoke-user-2");

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(second.length).toBeLessThanOrEqual(64);
  });

  it("imports legacy people into RBAC accounts without rewriting person or chat identity ids", async () => {
    const { importState } = await import("../../scripts/db-import-state.mjs");
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const connection = {
      execute: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return [{ affectedRows: 1 }];
      }
    };

    await importState(connection, {
      booths: [],
      tickets: [],
      messageRecords: [],
      people: [{
        id: "person-legacy",
        name: "Legacy User",
        phone: "13800138088",
        role: "handler",
        groupName: "Builder",
        enabled: true,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z"
      }],
      chatIdentities: [{
        id: "chat-legacy",
        platform: "wechat",
        externalUserId: "wxid-legacy",
        displayName: "Legacy WeChat",
        isTemporary: false,
        personId: "person-legacy",
        verifiedBy: "phone",
        verifiedAt: "2026-06-01T00:00:00.000Z",
        firstSeenAt: "2026-06-01T00:00:00.000Z",
        lastSeenAt: "2026-06-01T00:00:00.000Z"
      }],
      conversations: [],
      pendingWorkOrderSessions: [],
      outboundMessages: [],
      config: {
        userGroups: [{
          id: "builder",
          name: "Builder",
          description: "",
          canClaim: true,
          canProcess: true,
          canAccept: false,
          enabled: true
        }]
      }
    }, "legacy-state.json");

    const userGroupInsert = calls.find((call) =>
      call.sql.includes("INSERT INTO user_groups")
    );
    expect(userGroupInsert?.params.slice(0, 8)).toEqual([
      "builder",
      "Builder",
      "",
      true,
      true,
      false,
      false,
      true
    ]);
    const peopleInsert = calls.find((call) =>
      call.sql.includes("INSERT INTO people")
    );
    expect(peopleInsert?.params).toEqual(expect.arrayContaining([
      "person-legacy",
      "builder",
      "Builder"
    ]));
    const identityInsert = calls.find((call) =>
      call.sql.includes("INSERT INTO chat_identities")
    );
    expect(identityInsert?.params).toEqual(expect.arrayContaining([
      "chat-legacy",
      "person-legacy"
    ]));
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sql: expect.stringContaining("INSERT INTO roles"),
        params: expect.arrayContaining(["role-builder", "builder"])
      }),
      expect.objectContaining({
        sql: expect.stringContaining("INSERT INTO role_permissions"),
        params: expect.arrayContaining(["role-builder", "ticket.claim"])
      }),
      expect.objectContaining({
        sql: expect.stringContaining("INSERT INTO accounts"),
        params: expect.arrayContaining([
          "account-person-legacy",
          "person-legacy",
          "13800138088"
        ])
      }),
      expect.objectContaining({
        sql: expect.stringContaining("INSERT INTO account_roles"),
        params: expect.arrayContaining([
          "account-person-legacy",
          "role-builder"
        ])
      })
    ]));
    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO role_permissions") &&
      call.params.includes("admin.access")
    )).toBe(false);
  });

  it("imports booth location, area, and type into raw payload", async () => {
    const { importState } = await import("../../scripts/db-import-state.mjs");
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const connection = {
      execute: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return [{ affectedRows: 1 }];
      }
    };

    await importState(connection, {
      booths: [{
        boothNumber: "1ET06",
        companyName: "汕头市昌隆机械科技有限公司",
        companyShortName: "昌隆机械",
        location: "一楼 1E",
        area: "36",
        boothType: "普通绿搭",
        salesOwner: "孙晓晓",
        builder: "李铁：13607664172"
      }],
      tickets: [],
      messageRecords: [],
      people: [],
      chatIdentities: [],
      conversations: [],
      pendingWorkOrderSessions: [],
      outboundMessages: [],
      config: {}
    }, "legacy-state.json");

    const boothInsert = calls.find((call) => call.sql.includes("INSERT INTO exhibition_booths"));
    expect(boothInsert?.params[9]).toBe(JSON.stringify({
      location: "一楼 1E",
      area: "36",
      boothType: "普通绿搭"
    }));
  });

  it("imports persisted account credentials, sessions, and bootstrap status", async () => {
    const { importState } = await import("../../scripts/db-import-state.mjs");
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const connection = {
      execute: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return [{ affectedRows: 1 }];
      }
    };

    await importState(connection, {
      booths: [],
      tickets: [],
      messageRecords: [],
      people: [{
        id: "person-admin",
        name: "Admin",
        phone: "13800138000",
        role: "admin",
        groupId: "admin",
        groupName: "Administrators",
        enabled: true,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-02T00:00:00.000Z"
      }],
      accounts: [{
        id: "account-admin",
        personId: "person-admin",
        loginName: "13800138000",
        enabled: true,
        authVersion: 3,
        lastLoginAt: "2026-06-03T00:00:00.000Z",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z"
      }],
      accountCredentials: [{
        accountId: "account-admin",
        passwordHash: "scrypt$hash",
        passwordChangedAt: "2026-06-01T00:00:00.000Z",
        mustChangePassword: false,
        failedAttempts: 2,
        lockedUntil: "2026-06-04T00:00:00.000Z"
      }],
      accountSessions: [{
        id: "session-admin",
        accountId: "account-admin",
        sessionType: "admin",
        tokenHash: "a".repeat(64),
        authVersion: 3,
        expiresAt: "2026-06-05T00:00:00.000Z",
        lastSeenAt: "2026-06-03T00:00:00.000Z",
        createdAt: "2026-06-03T00:00:00.000Z"
      }],
      authBootstrap: {
        completedAt: "2026-06-01T00:00:00.000Z",
        completedByAccountId: "account-admin"
      },
      chatIdentities: [],
      conversations: [],
      pendingWorkOrderSessions: [],
      outboundMessages: [],
      config: {
        userGroups: [{
          id: "admin",
          name: "Administrators",
          description: "",
          canClaim: false,
          canProcess: false,
          canAccept: false,
          canAdmin: true,
          enabled: true
        }]
      }
    }, "state-with-auth.json");

    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sql: expect.stringContaining("INSERT INTO accounts"),
        params: expect.arrayContaining(["account-admin", "person-admin", "13800138000", true, 3])
      }),
      expect.objectContaining({
        sql: expect.stringContaining("INSERT INTO account_credentials"),
        params: expect.arrayContaining(["account-admin", "scrypt$hash", false, 2])
      }),
      expect.objectContaining({
        sql: expect.stringContaining("INSERT INTO account_sessions"),
        params: expect.arrayContaining(["session-admin", "account-admin", "admin", "a".repeat(64), 3])
      }),
      expect.objectContaining({
        sql: expect.stringContaining("UPDATE auth_bootstrap_state"),
        params: expect.arrayContaining(["account-admin", "admin"])
      })
    ]));
  });
});
