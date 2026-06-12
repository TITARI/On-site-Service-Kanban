import { describe, expect, it, vi } from "vitest";
import type { DatabaseConnection } from "@/lib/db/connection";
import { defaultConfig } from "@/lib/seed";
import {
  createAccountSession,
  resolveAccountSession,
  syncAccessRoles,
  upsertMobileAccount
} from "@/lib/db/mariadb-access-store";

function rowDate() {
  return new Date("2026-06-12T01:00:00.000Z");
}

function sessionConnection(): DatabaseConnection {
  return {
    execute: vi.fn(async (sql: string) => {
      if (sql.includes("FROM account_sessions s")) {
        return [[
          {
            session_id: "session-1",
            account_id: "account-1",
            session_type: "mobile",
            token_hash: "hash",
            session_auth_version: 2,
            expires_at: new Date("2026-06-13T01:00:00.000Z"),
            last_seen_at: rowDate(),
            session_created_at: rowDate(),
            person_id: "person-1",
            person_name: "张三",
            person_phone: "13800138000",
            group_id: "builder",
            group_name: "搭建组",
            permission_code: "ticket.process"
          },
          {
            session_id: "session-1",
            account_id: "account-1",
            session_type: "mobile",
            token_hash: "hash",
            session_auth_version: 2,
            expires_at: new Date("2026-06-13T01:00:00.000Z"),
            last_seen_at: rowDate(),
            session_created_at: rowDate(),
            person_id: "person-1",
            person_name: "张三",
            person_phone: "13800138000",
            group_id: "builder",
            group_name: "搭建组",
            permission_code: "ticket.claim"
          }
        ]];
      }
      return [[]];
    })
  } as unknown as DatabaseConnection;
}

function recordingConnection(responses: Array<unknown[]> = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const next = responses.shift();
    return [next ?? []];
  });
  return {
    connection: { execute } as unknown as DatabaseConnection,
    calls,
    sql: () => calls.map((call) => call.sql).join("\n")
  };
}

describe("MariaDB access store", () => {
  it("resolves an active session through account, person, role, and permissions", async () => {
    const result = await resolveAccountSession(sessionConnection(), "hash", "mobile");

    expect(result).toMatchObject({
      actor: {
        accountId: "account-1",
        personId: "person-1",
        groupId: "builder",
        permissions: ["ticket.claim", "ticket.process"]
      },
      session: {
        id: "session-1",
        tokenHash: "hash",
        authVersion: 2
      }
    });
  });

  it("uses the full active-session predicate and parameterized lookup", async () => {
    const connection = sessionConnection();
    await resolveAccountSession(connection, "hash", "admin");

    const execute = connection.execute as ReturnType<typeof vi.fn>;
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain("s.revoked_at IS NULL");
    expect(sql).toContain("s.expires_at > CURRENT_TIMESTAMP(3)");
    expect(sql).toContain("s.auth_version = a.auth_version");
    expect(sql).toContain("a.enabled = true");
    expect(sql).toContain("p.enabled = true");
    expect(sql).toContain("r.enabled = true");
    expect(sql).toContain("r.source_group_id = p.group_id");
    expect(sql).toContain("s.token_hash = ?");
    expect(sql).toContain("s.session_type = ?");
    expect(params).toEqual(["hash", "admin"]);
  });

  it("updates a mobile user and its single account role", async () => {
    const existing = {
      account_id: "account-1",
      person_id: "person-1",
      account_enabled: 1,
      person_enabled: 1,
      group_locked: 0,
      group_id: "builder",
      account_auth_version: 1
    };
    const actorRow = {
      account_id: "account-1",
      person_id: "person-1",
      person_name: "张三",
      person_phone: "13800138000",
      group_id: "builder",
      group_name: "搭建组",
      permission_code: "ticket.process"
    };
    const recorder = recordingConnection([
      [{ id: "builder", name: "搭建组", enabled: 1 }],
      [existing],
      [],
      [],
      [],
      [],
      [actorRow]
    ]);

    const result = await upsertMobileAccount(recorder.connection, defaultConfig(), {
      name: "张三",
      phone: "13800138000",
      groupId: "builder"
    });

    expect(result.actor.permissions).toEqual(["ticket.process"]);
    expect(recorder.sql()).toContain("UPDATE people");
    expect(recorder.sql()).toContain("DELETE FROM account_roles");
    expect(recorder.sql()).toContain("INSERT INTO account_roles");
    expect(recorder.calls.every((call) => !call.sql.includes("13800138000"))).toBe(true);
  });

  it("creates sessions and synchronizes role permissions with placeholders", async () => {
    const recorder = recordingConnection([
      [{
        account_id: "account-1",
        person_id: "person-1",
        person_name: "张三",
        person_phone: "13800138000",
        group_id: "builder",
        group_name: "搭建组",
        permission_code: "ticket.process"
      }],
      [{ auth_version: 3 }],
      []
    ]);
    const expiresAt = "2026-06-13T01:00:00.000Z";
    const session = await createAccountSession(
      recorder.connection,
      "account-1",
      "mobile",
      "token-hash",
      expiresAt
    );
    expect(session).toMatchObject({
      accountId: "account-1",
      sessionType: "mobile",
      tokenHash: "token-hash",
      authVersion: 3,
      expiresAt
    });
    expect(recorder.calls.at(-1)?.params).toEqual(expect.arrayContaining([
      "account-1",
      "mobile",
      "token-hash"
    ]));

    const syncRecorder = recordingConnection([[], [], [], [], [], []]);
    await syncAccessRoles(syncRecorder.connection, [{
      id: "ops",
      name: "运营组",
      description: "",
      canClaim: true,
      canProcess: false,
      canAccept: true,
      canAdmin: false,
      enabled: true
    }], rowDate());

    const sql = syncRecorder.sql();
    expect(sql).toContain("INSERT INTO roles");
    expect(sql).toContain("DELETE FROM role_permissions");
    expect(sql).toContain("INSERT INTO role_permissions");
    expect(syncRecorder.calls.flatMap((call) => call.params)).toEqual(expect.arrayContaining([
      "role-ops",
      "ticket.claim",
      "ticket.accept"
    ]));
  });
});
