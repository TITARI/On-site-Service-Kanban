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
});
