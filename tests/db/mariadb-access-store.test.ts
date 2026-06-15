import { describe, expect, it, vi } from "vitest";
import type { DatabaseConnection } from "@/lib/db/connection";
import type { AuthenticatedActor } from "@/lib/domain/access-control";
import type { UserGroup } from "@/lib/domain/types";
import { defaultConfig } from "@/lib/seed";
import { initialState } from "@/lib/storage/file-store";
import { syncAccessRolesInState } from "@/lib/services/access-state-service";
import {
  createUser,
  createAccountSession,
  deleteUser,
  getUser,
  listUsers,
  recordAccessRolesSync,
  recordAdminLoginFailure,
  recordAdminLoginSuccess,
  resolveAccountSession,
  revokeAccountSession,
  revokeAccountSessions,
  setUserPassword,
  syncAccessRoles,
  updateUser,
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

function persistedActorRows(
  permissionCode: string | null = "ticket.process",
  authVersion = 7
) {
  return [{
    account_id: "account-person-1",
    auth_version: authVersion,
    person_id: "person-1",
    person_name: "Alice",
    phone: "13800138000",
    group_id: "builder",
    group_name: "Builder",
    permission_code: permissionCode
  }];
}

function enabledGroupRow(
  id = "builder",
  name = "Builder"
) {
  return {
    id,
    name,
    description: "",
    can_claim: 1,
    can_process: 1,
    can_accept: 0,
    can_admin: 0,
    enabled: 1
  };
}

function userDetailRow(overrides: Record<string, unknown> = {}) {
  return {
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
    has_password: 0,
    permission_code: "ticket.process",
    identity_platform: null,
    identity_id: null,
    external_user_id: null,
    identity_display_name: null,
    ...overrides
  };
}

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
    expect(query.sql).toContain("s.expires_at > UTC_TIMESTAMP(3)");
    expect(query.sql).not.toContain("s.expires_at > CURRENT_TIMESTAMP(3)");
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
      if (sql.includes("FROM accounts a") && sql.includes("permission_code")) {
        return persistedActorRows();
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
    const authorization = calls.find((call) =>
      call.sql.includes("FROM accounts a") &&
      call.sql.includes("permission_code")
    );
    expect(authorization?.params).toEqual(["account-person-1"]);
    expect(authorization?.sql).toContain("a.enabled = true");
    expect(authorization?.sql).toContain("p.enabled = true");
    expect(authorization?.sql).toContain("g.enabled = true");
    expect(authorization?.sql).toContain("r.enabled = true");
    expect(authorization?.sql).toContain("r.source_group_id = p.group_id");
    expect(authorization?.sql).toContain("JOIN account_roles");
    expect(insert?.params[3]).toBe(tokenHash);
    expect(insert?.params[4]).toBe(7);
  });

  it.each([
    ["disabled account", "a.enabled = true"],
    ["disabled person", "p.enabled = true"],
    ["disabled group", "g.enabled = true"],
    ["disabled role", "r.enabled = true"],
    ["missing account role", "JOIN account_roles"],
    ["mismatched source group", "r.source_group_id = p.group_id"]
  ])("rejects session creation for a %s chain", async (_label, requiredSql) => {
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("SELECT id, auth_version FROM accounts")) {
        return [{ id: "account-person-1", auth_version: 7 }];
      }
      if (sql.includes("FROM accounts a") && sql.includes("permission_code")) {
        return [];
      }
      return { affectedRows: 1 };
    });

    await expect(createAccountSession(
      connection,
      "account-person-1",
      "mobile",
      tokenHash,
      "2099-01-01T00:00:00.000Z"
    )).rejects.toThrow(/not allowed|access chain/i);

    const authorization = calls.find((call) =>
      call.sql.includes("FROM accounts a") &&
      call.sql.includes("permission_code")
    );
    expect(authorization?.sql).toContain(requiredSql);
    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO account_sessions")
    )).toBe(false);
  });

  it("rejects admin session creation without admin.access", async () => {
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("SELECT id, auth_version FROM accounts")) {
        return [{ id: "account-person-1", auth_version: 7 }];
      }
      if (sql.includes("FROM accounts a") && sql.includes("permission_code")) {
        return persistedActorRows("ticket.process");
      }
      return { affectedRows: 1 };
    });

    await expect(createAccountSession(
      connection,
      "account-person-1",
      "admin",
      tokenHash,
      "2099-01-01T00:00:00.000Z"
    )).rejects.toThrow(/not allowed|access chain/i);
    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO account_sessions")
    )).toBe(false);
  });

  it("creates an admin session only from an enabled admin actor chain", async () => {
    const adminHash = "b".repeat(64);
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("SELECT id, auth_version FROM accounts")) {
        return [{ id: "account-person-1", auth_version: 11 }];
      }
      if (sql.includes("FROM accounts a") && sql.includes("permission_code")) {
        return persistedActorRows("admin.access", 11);
      }
      return { affectedRows: 1 };
    });

    await expect(createAccountSession(
      connection,
      "account-person-1",
      "admin",
      adminHash,
      "2099-01-01T00:00:00.000Z"
    )).resolves.toMatchObject({
      sessionType: "admin",
      tokenHash: adminHash,
      authVersion: 11
    });

    const insert = calls.find((call) =>
      call.sql.includes("INSERT INTO account_sessions")
    );
    expect(insert?.params[2]).toBe("admin");
    expect(insert?.params[3]).toBe(adminHash);
    expect(insert?.params[4]).toBe(11);
    expect(calls.some((call) =>
      call.sql.includes("FROM accounts a") &&
      call.sql.includes("permission_code")
    )).toBe(true);
  });

  it("preserves duplicate session hash database errors", async () => {
    const duplicate = Object.assign(new Error("Duplicate entry"), {
      code: "ER_DUP_ENTRY"
    });
    const { connection } = recordingConnection((sql) => {
      if (sql.includes("SELECT id, auth_version FROM accounts")) {
        return [{ id: "account-person-1", auth_version: 7 }];
      }
      if (sql.includes("FROM accounts a") && sql.includes("permission_code")) {
        return persistedActorRows();
      }
      if (sql.includes("INSERT INTO account_sessions")) throw duplicate;
      return { affectedRows: 1 };
    });

    await expect(createAccountSession(
      connection,
      "account-person-1",
      "mobile",
      tokenHash,
      "2099-01-01T00:00:00.000Z"
    )).rejects.toBe(duplicate);
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

  it("ignores an invalid submitted group for a locked mobile account", async () => {
    const { calls, connection } = recordingConnection((statement) => {
      if (statement.includes("FROM people p") && statement.includes("WHERE p.phone = ?")) {
        return [{
          person_id: "person-1",
          person_name: "Alice",
          phone: "13800138000",
          group_id: "builder",
          group_locked: 1,
          person_enabled: 1,
          account_id: "account-person-1",
          account_enabled: 1,
          auth_version: 3
        }];
      }
      if (statement.includes("authorization_fingerprint")) return [];
      if (statement.includes("WHERE a.id = ?") && statement.includes("permission_code")) {
        return persistedActorRows("ticket.process", 3);
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
      name: "Alice Locked",
      phone: "13800138000",
      groupId: "missing-or-disabled"
    })).resolves.toMatchObject({
      actor: {
        groupId: "builder"
      }
    });

    const existingRead = calls.findIndex((call) =>
      call.sql.includes("WHERE p.phone = ?")
    );
    const peopleUpdate = calls.find((call) =>
      call.sql.includes("UPDATE people")
    );
    expect(existingRead).toBeGreaterThanOrEqual(0);
    expect(peopleUpdate?.params).toContain("builder");
    expect(peopleUpdate?.params).not.toContain("missing-or-disabled");
  });

  it("rejects an invalid submitted group for an unlocked mobile account after reading it", async () => {
    const { calls, connection } = recordingConnection((statement) => {
      if (statement.includes("FROM people p") && statement.includes("WHERE p.phone = ?")) {
        return [{
          person_id: "person-1",
          person_name: "Alice",
          phone: "13800138000",
          group_id: "builder",
          group_locked: 0,
          person_enabled: 1,
          account_id: "account-person-1",
          account_enabled: 1,
          auth_version: 3
        }];
      }
      return statement.trimStart().startsWith("SELECT")
        ? []
        : { affectedRows: 1 };
    });

    await expect(upsertMobileAccount(connection, {
      ...defaultConfig(),
      userGroups: accessGroups()
    }, {
      name: "Alice",
      phone: "13800138000",
      groupId: "missing-or-disabled"
    })).rejects.toThrow(/group.*disabled|missing/i);

    expect(calls).not.toHaveLength(0);
    expect(calls[0].sql).toContain("WHERE p.phone = ?");
    expect(calls.some((call) =>
      call.sql.includes("UPDATE people") ||
      call.sql.includes("INSERT INTO people")
    )).toBe(false);
  });

  it("rejects an invalid submitted group for a new mobile account after lookup", async () => {
    const { calls, connection } = recordingConnection((statement) => (
      statement.trimStart().startsWith("SELECT")
        ? []
        : { affectedRows: 1 }
    ));

    await expect(upsertMobileAccount(connection, {
      ...defaultConfig(),
      userGroups: accessGroups()
    }, {
      name: "New User",
      phone: "13900139000",
      groupId: "missing-or-disabled"
    })).rejects.toThrow(/group.*disabled|missing/i);

    expect(calls).not.toHaveLength(0);
    expect(calls[0].sql).toContain("WHERE p.phone = ?");
    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO people")
    )).toBe(false);
  });

  it("rejects mobile upsert when one phone matches multiple legacy candidates", async () => {
    const { calls, connection } = recordingConnection((statement) => {
      if (statement.includes("FROM people p") && statement.includes("WHERE p.phone = ?")) {
        return [
          {
            person_id: "person-1",
            person_name: "Alice",
            phone: "13800138000",
            group_id: "builder",
            group_locked: 0,
            person_enabled: 1,
            account_id: "account-person-1",
            account_enabled: 1,
            auth_version: 3
          },
          {
            person_id: "person-legacy",
            person_name: "Legacy Alice",
            phone: "13800138000",
            group_id: "builder",
            group_locked: 0,
            person_enabled: 1,
            account_id: null,
            account_enabled: null,
            auth_version: null
          }
        ];
      }
      if (statement.includes("authorization_fingerprint")) return [];
      if (statement.includes("WHERE a.id = ?") && statement.includes("permission_code")) {
        return persistedActorRows("ticket.process", 3);
      }
      return statement.trimStart().startsWith("SELECT")
        ? []
        : { affectedRows: 1 };
    });

    await expect(upsertMobileAccount(connection, {
      ...defaultConfig(),
      userGroups: accessGroups()
    }, {
      name: "Alice",
      phone: "13800138000",
      groupId: "builder"
    })).rejects.toThrow(/multiple|conflict|duplicate/i);

    expect(calls[0].params).toEqual(["13800138000", "13800138000"]);
    expect(calls.some((call) =>
      call.sql.includes("UPDATE people") ||
      call.sql.includes("UPDATE accounts") ||
      call.sql.includes("INSERT INTO accounts")
    )).toBe(false);
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

  it("invalidates when one account loses one of multiple preexisting role links", async () => {
    let fingerprintReads = 0;
    const { calls, connection } = recordingConnection((statement) => {
      if (statement.includes("authorization_fingerprint")) {
        fingerprintReads += 1;
        return fingerprintReads === 1
          ? [
              {
                account_id: "account-person-1",
                authorization_fingerprint: "stale-admin-role"
              },
              {
                account_id: "account-person-1",
                authorization_fingerprint: "surviving-builder-role"
              }
            ]
          : [{
              account_id: "account-person-1",
              authorization_fingerprint: "surviving-builder-role"
            }];
      }
      if (statement.includes("account_authorization_rows")) {
        fingerprintReads += 1;
        return fingerprintReads === 1
          ? [
              {
                account_id: "account-person-1",
                account_enabled: 1,
                person_enabled: 1,
                group_id: "builder",
                group_enabled: 1,
                role_id: "role-admin",
                role_enabled: 1,
                role_source_group_id: "admin",
                permission_code: "admin.access"
              },
              {
                account_id: "account-person-1",
                account_enabled: 1,
                person_enabled: 1,
                group_id: "builder",
                group_enabled: 1,
                role_id: "role-builder",
                role_enabled: 1,
                role_source_group_id: "builder",
                permission_code: "ticket.process"
              }
            ]
          : [{
              account_id: "account-person-1",
              account_enabled: 1,
              person_enabled: 1,
              group_id: "builder",
              group_enabled: 1,
              role_id: "role-builder",
              role_enabled: 1,
              role_source_group_id: "builder",
              permission_code: "ticket.process"
            }];
      }
      return statement.trimStart().startsWith("SELECT")
        ? []
        : { affectedRows: 1 };
    });

    await syncAccessRoles(connection, accessGroups(), new Date("2026-06-14T02:30:00.000Z"));

    expect(calls.some((call) =>
      call.sql.includes("auth_version = auth_version + 1") &&
      call.params.includes("account-person-1")
    )).toBe(true);
  });

  it("does not invalidate when the aggregate authorization state is unchanged", async () => {
    let fingerprintReads = 0;
    const { calls, connection } = recordingConnection((statement) => {
      if (statement.includes("authorization_fingerprint")) {
        fingerprintReads += 1;
        return [
          {
            account_id: "account-person-1",
            authorization_fingerprint: "builder-role"
          }
        ];
      }
      if (statement.includes("account_authorization_rows")) {
        fingerprintReads += 1;
        return [{
          account_id: "account-person-1",
          account_enabled: 1,
          person_enabled: 1,
          group_id: "builder",
          group_enabled: 1,
          role_id: "role-builder",
          role_enabled: 1,
          role_source_group_id: "builder",
          permission_code: "ticket.process"
        }];
      }
      return statement.trimStart().startsWith("SELECT")
        ? []
        : { affectedRows: 1 };
    });

    await syncAccessRoles(connection, accessGroups(), new Date("2026-06-14T02:45:00.000Z"));

    expect(fingerprintReads).toBe(2);
    expect(calls.some((call) =>
      call.sql.includes("auth_version = auth_version + 1")
    )).toBe(false);
  });

  it("revokes all sessions and increments auth version idempotently", async () => {
    const now = new Date("2026-06-14T03:00:00.000Z");
    const { calls, connection } = recordingConnection((sql) => (
      sql.includes("UPDATE account_sessions")
        ? { affectedRows: 3 }
        : { affectedRows: 1 }
    ));

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
    const audit = calls.find((call) =>
      call.sql.includes("INSERT INTO audit_logs")
    );
    expect(JSON.parse(String(audit?.params[6]))).toEqual({
      accountId: "account-person-1",
      revokedCount: 3
    });
  });

  it("does not revoke sessions or audit when the account does not exist", async () => {
    const now = new Date("2026-06-14T03:15:00.000Z");
    const { calls, connection } = recordingConnection((sql) => (
      sql.includes("UPDATE accounts")
        ? { affectedRows: 0 }
        : { affectedRows: 1 }
    ));

    await revokeAccountSessions(connection, "missing-account", now);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("UPDATE accounts");
    expect(calls[0].params).toEqual([now, "missing-account"]);
  });

  it("revokes one session by canonical hash and audits no token material", async () => {
    const now = new Date("2026-06-14T03:30:00.000Z");
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("SELECT id, account_id, session_type")) {
        return [{
          id: "session-1",
          account_id: "account-person-1",
          session_type: "mobile",
          revoked_at: null
        }];
      }
      return { affectedRows: 1 };
    });

    await revokeAccountSession(connection, tokenHash, now);

    const update = calls.find((call) =>
      call.sql.includes("UPDATE account_sessions")
    );
    expect(update?.params).toEqual([now, tokenHash]);
    const audit = calls.find((call) =>
      call.sql.includes("INSERT INTO audit_logs")
    );
    expect(JSON.parse(String(audit?.params[6]))).toEqual({
      accountId: "account-person-1",
      sessionId: "session-1",
      sessionType: "mobile"
    });
    expect(String(audit?.params[6])).not.toContain(tokenHash);
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

  it("records successful admin login state with the persisted admin actor", async () => {
    const now = new Date("2026-06-14T04:00:00.000Z");
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("WHERE a.id = ?") && sql.includes("permission_code")) {
        return [{
          ...persistedActorRows("admin.access", 4)[0],
          account_id: "account-admin",
          person_id: "person-admin",
          person_name: "Root Admin",
          phone: "13700137000",
          group_id: "admin",
          group_name: "Administrators"
        }];
      }
      return { affectedRows: 1 };
    });

    await recordAdminLoginSuccess(connection, "account-admin", now);

    expect(calls.find((call) =>
      call.sql.includes("UPDATE account_credentials")
    )?.params).toEqual(["account-admin"]);
    expect(calls.find((call) =>
      call.sql.includes("SET last_login_at")
    )?.params).toEqual([now, now, "account-admin"]);
    const audit = calls.find((call) =>
      call.sql.includes("INSERT INTO audit_logs")
    );
    expect(audit?.params[1]).toBe("account-admin");
    expect(audit?.params[2]).toBe("Root Admin");
    expect(audit?.params[3]).toBe("admin.login.success");
  });

  it("uses the same recursive secret sanitizer for JSON and MariaDB audits", async () => {
    const auditPayload = {
      safe: "kept",
      password: "plain-password",
      PasswordHash: "stored-password-hash",
      nested: {
        refreshToken: "refresh-token",
        accessToken: "access-token",
        tokenHash: "stored-token-hash",
        clientSecretKey: "client-secret",
        confirmationSecret: "confirmation-secret",
        apiSecret: "api-secret",
        tokenCount: 4,
        observedAt: new Date("2026-06-14T04:30:00.000Z"),
        list: [{
          rotatedPasswordHash: "rotated-password-hash",
          value: "kept-value"
        }]
      }
    };
    const { calls, connection } = recordingConnection();
    const state = initialState();
    const groups = [{
      ...accessGroups()[0],
      id: auditPayload as unknown as string
    }];

    syncAccessRolesInState(state, groups);
    await recordAccessRolesSync(connection, groups);

    const audit = calls.find((call) =>
      call.sql.includes("INSERT INTO audit_logs")
    );
    const databaseDetail = JSON.parse(String(audit?.params[6]));
    const jsonDetail = JSON.parse(JSON.stringify(state.auditLogs?.[0].detail));
    const expected = {
      groupIds: [{
        safe: "kept",
        nested: {
          tokenCount: 4,
          observedAt: "2026-06-14T04:30:00.000Z",
          list: [{
            value: "kept-value"
          }]
        }
      }]
    };
    expect(jsonDetail).toEqual(expected);
    expect(databaseDetail).toEqual(expected);
    const serialized = JSON.stringify({ jsonDetail, databaseDetail });
    for (const secret of [
      "plain-password",
      "stored-password-hash",
      "refresh-token",
      "access-token",
      "stored-token-hash",
      "client-secret",
      "confirmation-secret",
      "api-secret",
      "rotated-password-hash"
    ]) {
      expect(serialized).not.toContain(secret);
    }
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

  it("creates a user with parameterized person, account, role, and audit writes", async () => {
    const injectedName = "Alice'); DROP TABLE accounts; --";
    const { calls, connection } = recordingConnection((sql, params) => {
      if (sql.includes("FROM user_groups") && sql.includes("enabled = true")) {
        return [enabledGroupRow()];
      }
      if (sql.includes("WHERE p.id = ? OR a.id = ?")) {
        const personId = String(params[0]);
        return [userDetailRow({
          person_id: personId,
          account_id: `account-${personId}`,
          person_name: injectedName
        })];
      }
      return sql.trimStart().startsWith("SELECT")
        ? []
        : { affectedRows: 1 };
    });

    await expect(createUser(connection, {
      name: injectedName,
      phone: "138 0013-8000",
      groupId: "builder",
      groupLocked: false,
      enabled: true
    }, actor())).resolves.toMatchObject({
      name: injectedName,
      phone: "13800138000",
      groupId: "builder"
    });

    const peopleInsert = calls.find((call) =>
      call.sql.includes("INSERT INTO people")
    );
    expect(peopleInsert?.params).toContain(injectedName);
    expect(calls.every((call) => !call.sql.includes(injectedName))).toBe(true);
    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO accounts")
    )).toBe(true);
    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO account_roles")
    )).toBe(true);
    const audit = calls.find((call) =>
      call.sql.includes("INSERT INTO audit_logs")
    );
    expect(JSON.parse(String(audit?.params[6]))).toMatchObject({
      name: injectedName,
      phone: "13800138000",
      groupId: "builder"
    });
  });

  it("rejects creating a user when a legacy person already owns the phone", async () => {
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("duplicate_phone_owners")) {
        return [{
          owner_person_id: "person-legacy",
          owner_account_id: null,
          owner_source: "people"
        }];
      }
      if (sql.includes("FROM user_groups") && sql.includes("enabled = true")) {
        return [enabledGroupRow()];
      }
      if (sql.includes("WHERE p.id = ? OR a.id = ?")) {
        return [userDetailRow()];
      }
      return sql.trimStart().startsWith("SELECT")
        ? []
        : { affectedRows: 1 };
    });

    await expect(createUser(connection, {
      name: "Alice",
      phone: "138 0013-8000",
      groupId: "builder",
      groupLocked: false,
      enabled: true
    }, actor())).rejects.toThrow(/already assigned/i);

    const duplicateRead = calls.find((call) =>
      call.sql.includes("duplicate_phone_owners")
    );
    expect(duplicateRead?.sql).toContain("FROM people");
    expect(duplicateRead?.sql).toContain("FROM accounts");
    expect(duplicateRead?.params).toContain("13800138000");
    expect(calls.every((call) => !call.sql.includes("13800138000"))).toBe(true);
    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO people") ||
      call.sql.includes("INSERT INTO accounts")
    )).toBe(false);
  });

  it("updates unrelated fields in a disabled group without revalidating or replacing the group role", async () => {
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("FOR UPDATE") && sql.includes("FROM accounts a")) {
        return [{
          account_id: "account-person-1",
          login_name: "13800138000",
          account_enabled: 1,
          person_id: "person-1",
          person_name: "Alice",
          phone: "13800138000",
          role: "handler",
          group_id: "disabled-group",
          group_name_snapshot: "Disabled Group",
          group_locked: 0,
          group_enabled: 0,
          person_enabled: 1
        }];
      }
      if (sql.includes("FROM user_groups") && sql.includes("enabled = true")) {
        return [];
      }
      if (sql.includes("WHERE p.id = ? OR a.id = ?")) {
        return [userDetailRow({
          person_name: "Alice Renamed",
          phone: "13900139000",
          group_id: "disabled-group",
          group_name: "Disabled Group",
          group_locked: 1,
          person_enabled: 0,
          account_enabled: 0
        })];
      }
      return sql.trimStart().startsWith("SELECT")
        ? []
        : { affectedRows: 1 };
    });

    await expect(updateUser(connection, "person-1", {
      name: "Alice Renamed",
      phone: "13900139000",
      groupLocked: true,
      enabled: false
    }, actor())).resolves.toMatchObject({
      name: "Alice Renamed",
      groupId: "disabled-group",
      groupName: "Disabled Group",
      groupLocked: true,
      enabled: false
    });

    expect(calls.some((call) =>
      call.sql.includes("FROM user_groups") &&
      call.sql.includes("enabled = true")
    )).toBe(false);
    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO roles") ||
      call.sql.includes("DELETE FROM account_roles") ||
      call.sql.includes("INSERT INTO account_roles")
    )).toBe(false);
    const peopleUpdate = calls.find((call) =>
      call.sql.includes("UPDATE people")
    );
    expect(peopleUpdate?.params.slice(2, 5)).toEqual([
      "handler",
      "disabled-group",
      "Disabled Group"
    ]);
    const audit = calls.find((call) =>
      call.sql.includes("INSERT INTO audit_logs")
    );
    expect(JSON.parse(String(audit?.params[6]))).toEqual({
      accountId: "account-person-1",
      changes: {
        name: { from: "Alice", to: "Alice Renamed" },
        phone: { from: "13800138000", to: "13900139000" },
        groupLocked: { from: false, to: true },
        enabled: { from: true, to: false }
      },
      authInvalidated: true
    });
  });

  it("rejects moving a user to a phone held by a legacy person without an account", async () => {
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("FOR UPDATE") && sql.includes("FROM accounts a")) {
        return [{
          account_id: "account-person-1",
          login_name: "13800138000",
          account_enabled: 1,
          person_id: "person-1",
          person_name: "Alice",
          phone: "13800138000",
          role: "handler",
          group_id: "builder",
          group_name_snapshot: "Builder",
          group_locked: 0,
          group_enabled: 1,
          person_enabled: 1
        }];
      }
      if (sql.includes("duplicate_phone_owners")) {
        return [{
          owner_person_id: "person-legacy",
          owner_account_id: null,
          owner_source: "people"
        }];
      }
      if (sql.includes("WHERE p.id = ? OR a.id = ?")) {
        return [userDetailRow({
          phone: "13900139000"
        })];
      }
      return sql.trimStart().startsWith("SELECT")
        ? []
        : { affectedRows: 1 };
    });

    await expect(updateUser(connection, "person-1", {
      phone: "13900139000"
    }, actor())).rejects.toThrow(/already assigned/i);

    const duplicateRead = calls.find((call) =>
      call.sql.includes("duplicate_phone_owners")
    );
    expect(duplicateRead?.params).toContain("13900139000");
    expect(duplicateRead?.params).toContain("person-1");
    expect(duplicateRead?.params).toContain("account-person-1");
    expect(calls.some((call) =>
      call.sql.includes("UPDATE people") ||
      call.sql.includes("UPDATE accounts")
    )).toBe(false);
  });

  it("rejects enabling a user whose unchanged current group is disabled", async () => {
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("FOR UPDATE") && sql.includes("FROM accounts a")) {
        return [{
          account_id: "account-person-1",
          login_name: "13800138000",
          account_enabled: 0,
          person_id: "person-1",
          person_name: "Alice",
          phone: "13800138000",
          role: "handler",
          group_id: "disabled-group",
          group_name_snapshot: "Disabled Group",
          group_locked: 0,
          group_enabled: 0,
          person_enabled: 0
        }];
      }
      if (sql.includes("FROM user_groups") && sql.includes("enabled = true")) {
        return [];
      }
      return sql.trimStart().startsWith("SELECT")
        ? []
        : { affectedRows: 1 };
    });

    await expect(updateUser(
      connection,
      "person-1",
      { enabled: true },
      actor()
    )).rejects.toThrow(/group.*disabled|missing/i);
    expect(calls.some((call) =>
      call.sql.includes("FROM user_groups") &&
      call.sql.includes("enabled = true")
    )).toBe(false);
    expect(calls.some((call) =>
      call.sql.includes("UPDATE people")
    )).toBe(false);
  });

  it("allows enabling a disabled user when moving to an enabled group", async () => {
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("FOR UPDATE") && sql.includes("FROM accounts a")) {
        return [{
          account_id: "account-person-1",
          login_name: "13800138000",
          account_enabled: 0,
          person_id: "person-1",
          person_name: "Alice",
          phone: "13800138000",
          role: "handler",
          group_id: "disabled-group",
          group_name_snapshot: "Disabled Group",
          group_locked: 0,
          group_enabled: 0,
          person_enabled: 0
        }];
      }
      if (sql.includes("FROM user_groups") && sql.includes("enabled = true")) {
        return [enabledGroupRow("builder", "Builder")];
      }
      if (sql.includes("WHERE p.id = ? OR a.id = ?")) {
        return [userDetailRow()];
      }
      return sql.trimStart().startsWith("SELECT")
        ? []
        : { affectedRows: 1 };
    });

    await expect(updateUser(connection, "person-1", {
      groupId: "builder",
      enabled: true
    }, actor())).resolves.toMatchObject({
      groupId: "builder",
      enabled: true
    });

    expect(calls.some((call) =>
      call.sql.includes("FROM user_groups") &&
      call.params.includes("builder")
    )).toBe(true);
    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO account_roles") &&
      call.params.includes("role-builder")
    )).toBe(true);
  });

  it("deletes a user and related access rows using bound identifiers", async () => {
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("FOR UPDATE") && sql.includes("FROM accounts a")) {
        return [{
          account_id: "account-person-1",
          login_name: "13800138000",
          account_enabled: 1,
          person_id: "person-1",
          person_name: "Alice",
          phone: "13800138000",
          role: "handler",
          group_id: "builder",
          group_name_snapshot: "Builder",
          group_locked: 0,
          group_enabled: 1,
          person_enabled: 1
        }];
      }
      return { affectedRows: 1 };
    });

    await deleteUser(connection, "person-1", actor());

    expect(calls.find((call) =>
      call.sql.includes("UPDATE chat_identities")
    )?.params).toEqual(["person-1"]);
    expect(calls.find((call) =>
      call.sql.includes("DELETE FROM account_sessions")
    )?.params).toEqual(["account-person-1"]);
    expect(calls.find((call) =>
      call.sql === "DELETE FROM accounts WHERE id = ?"
    )?.params).toEqual(["account-person-1"]);
    expect(calls.find((call) =>
      call.sql === "DELETE FROM people WHERE id = ?"
    )?.params).toEqual(["person-1"]);
    const audit = calls.find((call) =>
      call.sql.includes("INSERT INTO audit_logs")
    );
    expect(JSON.parse(String(audit?.params[6]))).toEqual({
      accountId: "account-person-1",
      phone: "13800138000",
      groupId: "builder"
    });
  });

  it.each([
    [true, "(p.enabled = true AND a.enabled = true)"],
    [false, "NOT (p.enabled = true AND a.enabled = true)"]
  ])("filters effective enabled=%s with the combined account and person status", async (
    enabled,
    expectedSql
  ) => {
    const { calls, connection } = recordingConnection((sql) => (
      sql.includes("COUNT(*) AS total") ? [{ total: 0 }] : []
    ));

    await listUsers(connection, {
      enabled,
      page: 1,
      pageSize: 20
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain(expectedSql);
    expect(calls[1].sql).toContain(expectedSql);
    expect(calls[0].params).toEqual([]);
    expect(calls[1].params).toEqual([20, 0]);
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

  it("filters admin users by effective enabled group and matching enabled role", async () => {
    const { calls, connection } = recordingConnection((sql) => (
      sql.includes("COUNT(*) AS total") ? [{ total: 0 }] : []
    ));

    await listUsers(connection, {
      admin: true,
      page: 1,
      pageSize: 20
    });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql).toContain("JOIN roles filter_r");
      expect(call.sql).toContain("filter_r.enabled = true");
      expect(call.sql).toContain("filter_r.source_group_id = p.group_id");
      expect(call.sql).toContain("JOIN user_groups filter_g");
      expect(call.sql).toContain("filter_g.enabled = true");
    }
  });

  it("filters admin users by effective enabled account and person", async () => {
    const { calls, connection } = recordingConnection((sql) => (
      sql.includes("COUNT(*) AS total") ? [{ total: 0 }] : []
    ));

    await listUsers(connection, {
      admin: true,
      page: 1,
      pageSize: 20
    });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql).toContain("p.enabled = true");
      expect(call.sql).toContain("a.enabled = true");
    }
  });

  it("derives user detail permissions from effective enabled group and matching enabled role", async () => {
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("COUNT(*) AS total")) return [{ total: 1 }];
      return sql.includes("paged_users")
        ? [userDetailRow({ permission_code: null })]
        : [];
    });

    const result = await listUsers(connection, {
      page: 1,
      pageSize: 20
    });

    expect(result.users[0]?.permissions).toEqual([]);
    const detailSql = calls[1].sql;
    expect(detailSql).toContain("LEFT JOIN roles r");
    expect(detailSql).toContain("r.enabled = true");
    expect(detailSql).toContain("r.source_group_id = p.group_id");
    expect(detailSql).toContain("LEFT JOIN role_permissions rp");
    expect(detailSql).toContain("g.enabled = true");
  });

  it.each([
    { field: "account_enabled", overrides: { account_enabled: 0 } },
    { field: "person_enabled", overrides: { person_enabled: 0 } }
  ])("omits listUsers permissions when $field is false", async ({ overrides }) => {
    const { connection } = recordingConnection((sql) => {
      if (sql.includes("COUNT(*) AS total")) return [{ total: 1 }];
      return sql.includes("paged_users")
        ? [userDetailRow(overrides)]
        : [];
    });

    const result = await listUsers(connection, {
      page: 1,
      pageSize: 20
    });

    expect(result.users[0]).toEqual(expect.objectContaining({
      enabled: false,
      permissions: []
    }));
  });

  it("derives getUser permissions from effective enabled group and matching enabled role", async () => {
    const { calls, connection } = recordingConnection(() => [
      userDetailRow({ permission_code: null })
    ]);

    const result = await getUser(connection, "person-1");

    expect(result?.permissions).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("LEFT JOIN roles r");
    expect(calls[0].sql).toContain("r.enabled = true");
    expect(calls[0].sql).toContain("r.source_group_id = p.group_id");
    expect(calls[0].sql).toContain("LEFT JOIN role_permissions rp");
    expect(calls[0].sql).toContain("g.enabled = true");
  });

  it.each([
    { field: "account_enabled", overrides: { account_enabled: 0 } },
    { field: "person_enabled", overrides: { person_enabled: 0 } }
  ])("omits getUser permissions when $field is false", async ({ overrides }) => {
    const { connection } = recordingConnection(() => [
      userDetailRow(overrides)
    ]);

    const result = await getUser(connection, "person-1");

    expect(result).toEqual(expect.objectContaining({
      enabled: false,
      permissions: []
    }));
  });

  it("searches chat identity identifiers with a parameterized EXISTS", async () => {
    const search = "WXID-ONLY%' OR 1=1 --";
    const { calls, connection } = recordingConnection((sql) => {
      if (sql.includes("COUNT(*) AS total")) return [{ total: 1 }];
      return sql.includes("paged_users") ? [userDetailRow({
        identity_platform: "wechat",
        identity_id: "identity-1",
        external_user_id: "wxid-only",
        identity_display_name: "Identity Only"
      })] : [];
    });

    const result = await listUsers(connection, {
      search,
      page: 1,
      pageSize: 20
    });

    expect(result.total).toBe(1);
    expect(result.users).toHaveLength(1);
    for (const call of calls) {
      expect(call.sql).not.toContain(search);
      expect(call.sql).toContain("EXISTS");
      expect(call.sql).toContain("FROM chat_identities");
      expect(call.sql).toContain("LOWER");
      expect(call.sql).toContain("external_user_id");
      expect(call.sql).toContain("display_name");
      expect(call.sql).toContain("platform");
    }
    const pattern = `%${search.toLowerCase()}%`;
    expect(calls[0].params).toEqual([pattern, pattern]);
    expect(calls[1].params).toEqual([pattern, pattern, 20, 0]);
  });

  it.each([
    "2026-02-30T00:00:00.000Z",
    "2099-01-01T00:00:00",
    "January 1, 2099"
  ])("rejects non-strict session expiry %s before SQL mutation", async (expiresAt) => {
    const { calls, connection } = recordingConnection();

    await expect(createAccountSession(
      connection,
      "account-person-1",
      "mobile",
      tokenHash,
      expiresAt
    )).rejects.toThrow(/valid ISO date string/i);

    expect(calls).toEqual([]);
  });

  it.each([
    "2026-02-30T00:00:00.000Z",
    "2099-01-01T00:00:00",
    "January 1, 2099"
  ])("rejects non-strict lockedUntil %s before SQL mutation", async (lockedUntil) => {
    const { calls, connection } = recordingConnection();

    await expect(recordAdminLoginFailure(
      connection,
      "account-admin",
      lockedUntil
    )).rejects.toThrow(/valid ISO date string/i);

    expect(calls).toEqual([]);
  });
});
