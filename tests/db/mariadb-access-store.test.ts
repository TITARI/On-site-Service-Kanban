import { describe, expect, it, vi } from "vitest";
import type { DatabaseConnection } from "@/lib/db/connection";
import { defaultConfig } from "@/lib/seed";
import {
  assertUsableAdminAfterGroupChange,
  bindChatIdentity,
  createAccountSession,
  resolveAccountSession,
  loadUserImportJob,
  saveUserImportPreview,
  syncAccessRoles,
  upsertMobileAccount,
  usableAdminCount,
  userDeletionHistory
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

  it("locks the target and occupied identity while performing a confirmed rebind", async () => {
    const { connection, calls, sql } = recordingConnection([
      [{
        account_id: "account-1",
        person_id: "person-1",
        name: "张三",
        phone: "13800138000",
        group_id: "builder",
        group_locked: 0,
        person_enabled: 1,
        account_enabled: 1
      }],
      [{
        id: "identity-1",
        platform: "wechat",
        external_user_id: "wxid-occupied",
        display_name: "李四微信",
        is_temporary: 0,
        person_id: "person-other"
      }],
      [],
      [],
      [],
      [{
        account_id: "account-1",
        person_id: "person-1",
        name: "张三",
        phone: "13800138000",
        group_id: "builder",
        group_name: "搭建组",
        group_locked: 0,
        person_enabled: 1,
        account_enabled: 1,
        permission_codes: "ticket.process",
        has_password: 0,
        person_updated_at: rowDate(),
        account_updated_at: rowDate()
      }],
      [{
        id: "identity-1",
        person_id: "person-1",
        platform: "wechat",
        external_user_id: "wxid-occupied",
        display_name: "张三微信"
      }]
    ]);
    const actor = {
      accountId: "account-admin",
      personId: "person-admin",
      name: "Root Admin",
      phone: "13700137000",
      groupId: "admin",
      groupName: "Administrators",
      permissions: ["admin.access"] as const,
      sessionType: "admin" as const
    };

    const result = await bindChatIdentity(connection, {
      userId: "person-1",
      platform: "wechat",
      identityId: "identity-1",
      externalUserId: "wxid-occupied",
      displayName: "张三微信",
      confirmedRebindFromPersonId: "person-other"
    }, actor);

    expect(result.identities.wechat?.externalUserId).toBe("wxid-occupied");
    expect(sql()).toContain("FOR UPDATE");
    expect(sql()).toContain("SET person_id = NULL");
    expect(calls.some((call) => call.params.includes("chat_identity.rebind"))).toBe(true);
    expect(calls.some((call) => call.params.some((param) => (
      typeof param === "string" && param.includes("\"fromPersonId\":\"person-other\"")
    )))).toBe(true);
  });

  it("stores and reloads a people import preview with conflict snapshots", async () => {
    const save = recordingConnection([[], []]);
    const job = {
      id: "import-job-1",
      type: "people" as const,
      ownerAccountId: "account-admin",
      sourceName: "users.xlsx",
      sourceHash: "a".repeat(64),
      previewVersion: "preview-1",
      status: "preview" as const,
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
      rows: [{
        id: "row-1",
        rowNumber: 2,
        raw: { 姓名: "张三" },
        normalized: {
          name: "张三",
          phone: "13800138000",
          groupId: "builder",
          groupLocked: true,
          enabled: true,
          wechatExternalUserId: "wxid-occupied"
        },
        errors: [],
        conflicts: ["wechat-occupied"],
        allowedActions: ["add" as const, "skip" as const],
        snapshot: {
          wechatIdentity: {
            id: "identity-1",
            personId: "person-other",
            lastSeenAt: "2026-06-12T00:00:00.000Z"
          }
        }
      }]
    };

    await saveUserImportPreview(save.connection, job);

    expect(save.sql()).toContain("INSERT INTO import_jobs");
    expect(save.sql()).toContain("normalized_payload");
    expect(save.calls.some((call) => call.params.some((param) => (
      typeof param === "string" && param.includes("wechat-occupied")
    )))).toBe(true);

    const load = recordingConnection([
      [{
        id: job.id,
        type: "people",
        owner_account_id: job.ownerAccountId,
        source_name: job.sourceName,
        source_hash: job.sourceHash,
        preview_version: job.previewVersion,
        status: "preview",
        created_at: rowDate(),
        updated_at: rowDate()
      }],
      [{
        id: "row-1",
        row_number: 2,
        raw_payload: JSON.stringify(job.rows[0].raw),
        normalized_payload: JSON.stringify(job.rows[0].normalized),
        conflict_json: JSON.stringify({
          errors: [],
          conflicts: ["wechat-occupied"],
          allowedActions: ["add", "skip"],
          snapshot: job.rows[0].snapshot
        }),
        decision_json: null,
        result_action: null,
        message: null
      }]
    ]);

    const restored = await loadUserImportJob(load.connection, job.id);

    expect(restored?.rows[0]).toMatchObject({
      normalized: job.rows[0].normalized,
      conflicts: ["wechat-occupied"],
      snapshot: job.rows[0].snapshot
    });
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

  it("checks for a credentialed enabled admin before applying group changes", async () => {
    const adminGroup = {
      id: "admin",
      name: "Administrators",
      description: "",
      canClaim: false,
      canProcess: false,
      canAccept: false,
      canAdmin: true,
      enabled: true
    };
    const recorder = recordingConnection([
      [{ completed_at: rowDate() }],
      [{ usable_admin_count: 1 }]
    ]);

    await expect(assertUsableAdminAfterGroupChange(
      recorder.connection,
      [adminGroup]
    )).resolves.toBeUndefined();
    expect(recorder.sql()).toContain("JOIN account_credentials");
    expect(recorder.calls.at(-1)?.params).toEqual(["admin"]);

    const missing = recordingConnection([
      [{ completed_at: rowDate() }],
      [{ usable_admin_count: 0 }]
    ]);
    await expect(assertUsableAdminAfterGroupChange(
      missing.connection,
      [adminGroup]
    )).rejects.toThrow("必须保留至少一位可用后台管理员");
  });

  it("counts usable admins through the complete permission chain", async () => {
    const recorder = recordingConnection([[{ total: 2 }]]);

    await expect(usableAdminCount(recorder.connection)).resolves.toBe(2);

    const sql = recorder.sql();
    expect(sql).toContain("JOIN account_credentials");
    expect(sql).toContain("rp.permission_code = 'admin.access'");
    expect(sql).toContain("a.enabled = true");
    expect(sql).toContain("p.enabled = true");
  });

  it("checks business history while ignoring target-only maintenance audits", async () => {
    const recorder = recordingConnection([
      [{ account_id: "account-1", person_id: "person-1" }],
      [{ id: "identity-1" }],
      [{ total: 0 }],
      [{ total: 0 }],
      [{ total: 0 }],
      [{ total: 0 }],
      [{ total: 0 }],
      [{ total: 0 }]
    ]);

    await expect(userDeletionHistory(recorder.connection, "person-1")).resolves.toEqual({
      deletable: true,
      reasons: []
    });

    const sql = recorder.sql();
    expect(sql).toContain("reporter_person_id");
    expect(sql).toContain("target_chat_identity_id");
    expect(sql).toContain("audit_logs WHERE actor_id");
    expect(sql).not.toContain("audit_logs WHERE target_id");
  });
});
