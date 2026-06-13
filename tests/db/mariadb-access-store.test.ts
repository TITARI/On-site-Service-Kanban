import { describe, expect, it, vi } from "vitest";
import type { DatabaseConnection } from "@/lib/db/connection";
import type { AuthenticatedActor } from "@/lib/domain/access-control";
import type { UserGroup } from "@/lib/domain/types";
import { defaultConfig } from "@/lib/seed";
import {
  createAccountSession,
  listUsers,
  recordAdminLoginFailure,
  resolveAccountSession,
  revokeAccountSessions,
  setUserPassword,
  syncAccessRoles,
  upsertMobileAccount
} from "@/lib/db/mariadb-access-store";

type RecordedCall = {
  sql: string;
  params: unknown[];
};

function recordingConnection(
  respond: (sql: string, params: unknown[]) => unknown = () => ({ affectedRows: 1 })
) {
  const calls: RecordedCall[] = [];
  const connection = {
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return [respond(sql, params)];
    })
  } as unknown as DatabaseConnection;
  return {
    calls,
    connection,
    sql: () => calls.map((call) => call.sql).join("\n")
  };
}

function accessGroups(): UserGroup[] {
  return [
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
      id: "admin",
      name: "Administrators",
      description: "",
      canClaim: false,
      canProcess: false,
      canAccept: false,
      canAdmin: true,
      enabled: true
    }
  ];
}

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

const tokenHash = "a".repeat(64);

describe("MariaDB access store", () => {
  it("resolves one active session actor through enabled account, person, role, and permission joins", async () => {
    const { calls, connection } = recordingConnection((sql) => {
      if (!sql.includes("FROM account_sessions s")) return [];
      return [
        {
          session_id: "session-1",
          account_id: "account-person-1",
          session_type: "mobile",
          token_hash: tokenHash,
          session_auth_version: 2,
          expires_at: new Date("2099-01-01T00:00:00.000Z"),
          last_seen_at: new Date("2026-06-14T01:00:00.000Z"),
          revoked_at: null,
          session_created_at: new Date("2026-06-14T01:00:00.000Z"),
          person_id: "person-1",
          person_name: "Alice",
          phone: "13800138000",
          group_id: "builder",
          group_name: "Builder",
          permission_code: "ticket.process"
        },
        {
          session_id: "session-1",
          account_id: "account-person-1",
          session_type: "mobile",
          token_hash: tokenHash,
          session_auth_version: 2,
          expires_at: new Date("2099-01-01T00:00:00.000Z"),
          last_seen_at: new Date("2026-06-14T01:00:00.000Z"),
          revoked_at: null,
          session_created_at: new Date("2026-06-14T01:00:00.000Z"),
          person_id: "person-1",
          person_name: "Alice",
          phone: "13800138000",
          group_id: "builder",
          group_name: "Builder",
          permission_code: "ticket.process"
        }
      ];
    });

    await expect(
      resolveAccountSession(connection, tokenHash, "mobile")
    ).resolves.toMatchObject({
      session: {
        id: "session-1",
        authVersion: 2
      },
      actor: {
        accountId: "account-person-1",
        permissions: ["ticket.process"]
      }
    });

    const query = calls[0];
    expect(query.params).toEqual([tokenHash, "mobile"]);
    expect(query.sql).toContain("s.revoked_at IS NULL");
    expect(query.sql).toContain("s.expires_at > CURRENT_TIMESTAMP(3)");
    expect(query.sql).toContain("s.auth_version = a.auth_version");
    expect(query.sql).toContain("a.enabled = true");
    expect(query.sql).toContain("p.enabled = true");
    expect(query.sql).toContain("r.enabled = true");
    expect(query.sql).toContain("r.source_group_id = p.group_id");
    expect(query.sql).toContain("JOIN account_roles");
    expect(query.sql).toContain("JOIN role_permissions");
  });

  it("rejects malformed session hashes before issuing SQL", async () => {
    const { connection } = recordingConnection();

    await expect(
      resolveAccountSession(connection, "A".repeat(64), "mobile")
    ).rejects.toThrow(/session token hash/i);
    expect(connection.execute).not.toHaveBeenCalled();
  });

  it("creates a hash-only session with the current account auth version", async () => {
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("SELECT id, auth_version FROM accounts")) {
        return [{ id: "account-person-1", auth_version: 7 }];
      }
      return { affectedRows: 1 };
    });

    const session = await createAccountSession(
      connection,
      "account-person-1",
      "mobile",
      tokenHash,
      "2099-01-01T00:00:00.000Z"
    );

    expect(session).toMatchObject({
      accountId: "account-person-1",
      tokenHash,
      authVersion: 7
    });
    const insert = calls.find((call) => call.sql.includes("INSERT INTO account_sessions"));
    expect(insert?.params).toContain(tokenHash);
    expect(insert?.params).toContain(7);
    expect(JSON.stringify(calls)).not.toContain("raw-session-token");
  });

  it("updates an unlocked mobile account and its single role using parameterized SQL", async () => {
    let actorReads = 0;
    const { calls, connection, sql } = recordingConnection((statement) => {
      if (statement.includes("authorization_fingerprint")) return [];
      if (statement.includes("FROM people p") && statement.includes("WHERE p.phone = ?")) {
        return [{
          person_id: "person-1",
          person_name: "Old Name",
          phone: "13800138000",
          group_id: "old-group",
          group_locked: 0,
          person_enabled: 1,
          account_id: "account-person-1",
          account_enabled: 1,
          auth_version: 3
        }];
      }
      if (statement.includes("WHERE a.id = ?") && statement.includes("permission_code")) {
        actorReads += 1;
        return [{
          account_id: "account-person-1",
          person_id: "person-1",
          person_name: "Robert'); DROP TABLE people; --",
          phone: "13800138000",
          group_id: "builder",
          group_name: "Builder",
          permission_code: "ticket.claim"
        }];
      }
      return statement.trimStart().startsWith("SELECT")
        ? []
        : { affectedRows: 1 };
    });
    const config = {
      ...defaultConfig(),
      userGroups: accessGroups()
    };

    await expect(upsertMobileAccount(connection, config, {
      name: "Robert'); DROP TABLE people; --",
      phone: "138 0013-8000",
      groupId: "builder"
    })).resolves.toMatchObject({
      actor: {
        groupId: "builder",
        permissions: ["ticket.claim"]
      }
    });

    expect(sql()).toContain("UPDATE people");
    expect(sql()).toContain("UPDATE accounts");
    expect(sql()).toContain("DELETE FROM account_roles");
    expect(sql()).toContain("INSERT INTO account_roles");
    expect(actorReads).toBe(1);
    expect(sql()).not.toContain("Robert'); DROP TABLE people; --");
    expect(calls.some((call) =>
      call.params.includes("Robert'); DROP TABLE people; --")
    )).toBe(true);
  });

  it("synchronizes stable roles, exact permissions, and account links repeatedly", async () => {
    let fingerprintReads = 0;
    const { calls, connection, sql } = recordingConnection((statement) => {
      if (statement.includes("authorization_fingerprint")) {
        fingerprintReads += 1;
        return fingerprintReads === 1
          ? [{
              account_id: "account-person-1",
              authorization_fingerprint: "before"
            }]
          : [{
              account_id: "account-person-1",
              authorization_fingerprint: "after"
            }];
      }
      return statement.trimStart().startsWith("SELECT")
        ? []
        : { affectedRows: 1 };
    });

    await syncAccessRoles(connection, accessGroups(), new Date("2026-06-14T02:00:00.000Z"));

    const roleInsert = calls.find((call) => call.sql.includes("INSERT INTO roles"));
    expect(roleInsert?.params.slice(0, 3)).toEqual([
      "role-builder",
      "Builder",
      "builder"
    ]);
    expect(sql()).toContain("DELETE FROM role_permissions WHERE role_id = ?");
    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO role_permissions") &&
      call.params.includes("ticket.process")
    )).toBe(true);
    expect(sql()).toContain("DELETE FROM account_roles");
    expect(sql()).toContain("INSERT INTO account_roles");
    expect(calls.some((call) =>
      call.sql.includes("auth_version = auth_version + 1") &&
      call.params.includes("account-person-1")
    )).toBe(true);
  });

  it("revokes all sessions and increments auth version idempotently", async () => {
    const now = new Date("2026-06-14T03:00:00.000Z");
    const { calls, connection } = recordingConnection();

    await revokeAccountSessions(connection, "account-person-1", now);

    const accountUpdate = calls.find((call) =>
      call.sql.includes("auth_version = auth_version + 1")
    );
    const sessionUpdate = calls.find((call) =>
      call.sql.includes("UPDATE account_sessions")
    );
    expect(accountUpdate?.params).toEqual([now, "account-person-1"]);
    expect(sessionUpdate?.sql).toContain("revoked_at IS NULL");
    expect(sessionUpdate?.params).toEqual([now, "account-person-1"]);
  });

  it("records failed login counters with an unauthenticated system audit actor", async () => {
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("SELECT failed_attempts")) {
        return [{ failed_attempts: 2, locked_until: null }];
      }
      return { affectedRows: 1 };
    });

    await recordAdminLoginFailure(
      connection,
      "account-admin",
      "2099-01-01T00:00:00.000Z"
    );

    const audit = calls.find((call) => call.sql.includes("INSERT INTO audit_logs"));
    expect(audit?.params[1]).toBeNull();
    expect(audit?.params[2]).toBe("system");
    expect(audit?.params).toContain("admin.login.failure");
    expect(audit?.params).toContain("account-admin");
    expect(JSON.stringify(audit?.params)).not.toMatch(/password|token_hash/i);
  });

  it("sets a password without exposing it in audit detail and invalidates sessions", async () => {
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("FROM accounts") && sql.includes("person_id")) {
        return [{ id: "account-person-1", person_id: "person-1" }];
      }
      return { affectedRows: 1 };
    });

    await setUserPassword(
      connection,
      "person-1",
      "scrypt$secret-hash",
      actor()
    );

    expect(calls.some((call) =>
      call.sql.includes("account_credentials") &&
      call.params.includes("scrypt$secret-hash")
    )).toBe(true);
    const audit = calls.find((call) => call.sql.includes("INSERT INTO audit_logs"));
    expect(JSON.stringify(audit?.params)).not.toContain("scrypt$secret-hash");
    expect(calls.some((call) =>
      call.sql.includes("auth_version = auth_version + 1")
    )).toBe(true);
  });

  it("lists filtered users with separate count, stable pagination, grouped identities, and no interpolation", async () => {
    const search = "Alice%' OR 1=1 --";
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("COUNT(*) AS total")) return [{ total: 1 }];
      if (!sql.includes("paged_users")) return [];
      return [
        {
          person_id: "person-1",
          account_id: "account-person-1",
          person_name: "Alice",
          phone: "13800138000",
          group_id: "builder",
          group_name: "Builder",
          group_locked: 0,
          person_enabled: 1,
          account_enabled: 1,
          last_login_at: null,
          person_updated_at: new Date("2026-06-14T01:00:00.000Z"),
          account_updated_at: new Date("2026-06-14T01:00:00.000Z"),
          has_password: 1,
          permission_code: "ticket.process",
          identity_platform: "wechat",
          identity_id: "identity-1",
          external_user_id: "wxid-1",
          identity_display_name: "Alice WeChat"
        },
        {
          person_id: "person-1",
          account_id: "account-person-1",
          person_name: "Alice",
          phone: "13800138000",
          group_id: "builder",
          group_name: "Builder",
          group_locked: 0,
          person_enabled: 1,
          account_enabled: 1,
          last_login_at: null,
          person_updated_at: new Date("2026-06-14T01:00:00.000Z"),
          account_updated_at: new Date("2026-06-14T01:00:00.000Z"),
          has_password: 1,
          permission_code: "ticket.claim",
          identity_platform: "wechat",
          identity_id: "identity-1",
          external_user_id: "wxid-1",
          identity_display_name: "Alice WeChat"
        }
      ];
    });

    const result = await listUsers(connection, {
      search,
      groupId: "builder",
      enabled: true,
      admin: false,
      binding: "bound",
      page: 2,
      pageSize: 10
    });

    expect(result.total).toBe(1);
    expect(result.users).toEqual([
      expect.objectContaining({
        personId: "person-1",
        permissions: ["ticket.claim", "ticket.process"],
        identities: {
          wechat: {
            id: "identity-1",
            externalUserId: "wxid-1",
            displayName: "Alice WeChat"
          }
        }
      })
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain("COUNT(*) AS total");
    expect(calls[1].sql).toContain("ORDER BY p.name, p.id");
    expect(calls[1].params.slice(-2)).toEqual([10, 10]);
    expect(calls.every((call) => !call.sql.includes(search))).toBe(true);
    expect(calls.some((call) => call.params.includes(`%${search.toLowerCase()}%`))).toBe(true);
  });
});
