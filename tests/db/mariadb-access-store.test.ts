import { describe, expect, it, vi } from "vitest";
import type { DatabaseConnection } from "@/lib/db/connection";
import type { AuthenticatedActor } from "@/lib/domain/access-control";
import type { UserGroup } from "@/lib/domain/types";
import { defaultConfig } from "@/lib/seed";
import {
  createUser,
  createAccountSession,
  deleteUser,
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

  it("recursively sanitizes secret keys before writing audit JSON", async () => {
    const nestedId = {
      safe: "kept",
      password: "plain-password",
      PasswordHash: "stored-password-hash",
      nested: {
        TOKEN: "raw-token",
        tokenHash: "stored-token-hash",
        list: [{
          secret: "nested-secret",
          ConfirmationSecret: "confirmation-secret",
          passwordHint: "kept-hint",
          value: "kept-value"
        }]
      }
    };
    const { calls, connection } = recordingConnection();

    await recordAccessRolesSync(connection, [{
      ...accessGroups()[0],
      id: nestedId as unknown as string
    }]);

    const audit = calls.find((call) =>
      call.sql.includes("INSERT INTO audit_logs")
    );
    const detail = JSON.parse(String(audit?.params[6]));
    expect(detail).toEqual({
      groupIds: [{
        safe: "kept",
        nested: {
          list: [{
            passwordHint: "kept-hint",
            value: "kept-value"
          }]
        }
      }]
    });
    expect(String(audit?.params[6])).not.toMatch(
      /plain-password|stored-password-hash|raw-token|stored-token-hash|nested-secret|confirmation-secret/
    );
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
});
