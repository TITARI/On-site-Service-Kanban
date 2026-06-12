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

  it("adds RBAC records to legacy state without changing person or chat identity ids", async () => {
    const { normalizeAccessStateForImport } = await import("../../scripts/db-import-state.mjs");
    const state = {
      config: {
        userGroups: [{
          id: "builder",
          name: "搭建组",
          description: "搭建",
          canClaim: true,
          canProcess: true,
          canAccept: false,
          canAdmin: false,
          enabled: true
        }]
      },
      people: [{
        id: "person-existing",
        name: "张三",
        phone: "13800138000",
        role: "handler",
        groupName: "搭建组",
        enabled: true,
        createdAt: "2026-05-27T12:00:00.000Z",
        updatedAt: "2026-05-27T12:00:00.000Z"
      }],
      chatIdentities: [{
        id: "chat-existing",
        platform: "wechat",
        externalUserId: "wxid-zhangsan",
        displayName: "张三微信",
        personId: "person-existing",
        firstSeenAt: "2026-05-27T12:00:00.000Z",
        lastSeenAt: "2026-05-27T12:00:00.000Z"
      }],
      auditLogs: [{
        id: "audit-existing",
        actorName: "system",
        action: "legacy.import",
        targetType: "state",
        detail: {
          password: "clear-password",
          nested: {
            sessionToken: "clear-token",
            confirmationSecret: "clear-secret",
            groupId: "builder"
          }
        },
        createdAt: "2026-05-27T12:00:00.000Z"
      }]
    };

    const normalized = normalizeAccessStateForImport(state, new Date("2026-06-12T00:00:00.000Z"));

    expect(normalized.people[0]).toMatchObject({
      id: "person-existing",
      groupId: "builder",
      groupName: "搭建组"
    });
    expect(normalized.chatIdentities[0]).toMatchObject({
      id: "chat-existing",
      personId: "person-existing"
    });
    expect(normalized.accounts).toContainEqual(expect.objectContaining({
      id: "account-person-existing",
      personId: "person-existing",
      loginName: "13800138000"
    }));
    expect(normalized.accountRoles).toContainEqual(expect.objectContaining({
      accountId: "account-person-existing",
      roleId: "role-builder"
    }));
    expect(normalized.rolePermissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: "role-builder", permissionCode: "ticket.claim" }),
      expect.objectContaining({ roleId: "role-builder", permissionCode: "ticket.process" })
    ]));
    expect(normalized.auditLogs[0].detail).toEqual({
      nested: { groupId: "builder" }
    });
    expect(JSON.stringify(normalized.auditLogs)).not.toContain("clear-password");
    expect(JSON.stringify(normalized.auditLogs)).not.toContain("clear-token");
    expect(JSON.stringify(normalized.auditLogs)).not.toContain("clear-secret");
  });
});
