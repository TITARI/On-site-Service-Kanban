import { beforeEach, describe, expect, it, vi } from "vitest";
import { MariaDbStateStore } from "@/lib/db/mariadb-state-store";
import type { DatabaseConnection } from "@/lib/db/connection";
import type { AppState } from "@/lib/domain/app-state";
import type { UserGroup } from "@/lib/domain/types";
import { defaultConfig } from "@/lib/seed";

const databaseMocks = vi.hoisted(() => {
  let connection: DatabaseConnection;
  return {
    getDatabasePool: vi.fn(() => connection),
    setConnection: (next: DatabaseConnection) => {
      connection = next;
    },
    withDatabaseTransaction: vi.fn(async <T>(
      operation: (connection: DatabaseConnection) => Promise<T>
    ) => operation(connection))
  };
});

vi.mock("@/lib/db/connection", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/connection")>(
    "@/lib/db/connection"
  );
  return {
    ...actual,
    getDatabasePool: databaseMocks.getDatabasePool,
    withDatabaseTransaction: databaseMocks.withDatabaseTransaction
  };
});

function rowDate() {
  return new Date("2026-06-04T01:00:00.000Z");
}

function fakeConnection(): DatabaseConnection {
  return {
    execute: vi.fn(async (sql: string) => {
      if (sql.includes("FROM app_config_versions")) return [[]];
      if (sql.includes("FROM ticket_feedback_users")) return [[]];
      if (sql.includes("FROM tickets")) return [[]];
      if (sql.includes("FROM exhibition_booths")) return [[{
        booth_number: "A01",
        company_name: "Test Company",
        company_short_name: "Test",
        sales_owner: "Owner",
        builder: "Builder"
      }]];
      if (sql.includes("FROM inbound_messages")) return [[{
        id: "message-1",
        channel: "wechat",
        external_message_id: "external-1",
        sender_id: "sender-1",
        sender_name: "Reporter",
        sender_phone: "13800138000",
        sender_group: "现场群",
        text: "A01 网络断了",
        received_at: rowDate(),
        created_at: rowDate(),
        reporter_person_id: "person-1",
        reporter_chat_identity_id: "identity-1",
        source_conversation_id: "conv-1",
        analysis_json: JSON.stringify({ boothNumber: "A01", issueType: "网络", confidence: 0.9, suggestedAction: "create-ticket", reason: "matched" })
      }]];
      if (sql.includes("FROM people")) return [[{
        id: "person-1",
        name: "张三",
        phone: "13800138000",
        role: "handler",
        group_id: "builder",
        group_name_snapshot: "搭建组",
        name_conflict: null,
        group_locked: 1,
        booth_scope: JSON.stringify(["A01"]),
        enabled: 1,
        created_at: rowDate(),
        updated_at: rowDate()
      }]];
      if (sql.includes("FROM chat_identities")) return [[{
        id: "identity-1",
        platform: "wechat",
        external_user_id: "wxid-1",
        display_name: "张三微信",
        is_temporary: 0,
        person_id: "person-1",
        verified_by: "phone",
        verified_at: rowDate(),
        first_seen_at: rowDate(),
        last_seen_at: rowDate()
      }]];
      if (sql.includes("FROM conversations")) return [[{
        id: "conv-1",
        platform: "wechat",
        type: "group",
        external_conversation_id: "现场群",
        title: "现场群",
        default_notify: 1,
        created_at: rowDate(),
        updated_at: rowDate()
      }]];
      if (sql.includes("FROM conversation_people")) return [[{
        conversation_id: "conv-1",
        person_id: "person-1"
      }]];
      if (sql.includes("FROM pending_work_order_sessions")) return [[{
        id: "pending-1",
        platform: "wechat",
        conversation_id: "conv-1",
        chat_identity_id: "identity-1",
        original_message_record_id: "message-1",
        draft_text: "A01 网络断了",
        draft_images: JSON.stringify([]),
        identity_group: "搭建组",
        contact_name: "张三",
        contact_phone: "13800138000",
        person_id: "person-1",
        booth_number: "A01",
        issue_type: "网络",
        missing_fields: JSON.stringify(["phone"]),
        created_at: rowDate(),
        updated_at: rowDate(),
        last_prompt_at: rowDate()
      }]];
      if (sql.includes("FROM outbound_messages")) return [[{
        id: "outbound-1",
        channel: "wechat",
        target_conversation_id: "现场群",
        target_chat_identity_id: "identity-1",
        target_name: "现场群",
        text: "请补充信息",
        related_ticket_id: null,
        related_session_id: "pending-1",
        status: "pending",
        retry_count: 0,
        last_error: null,
        claimed_at: null,
        sent_at: null,
        created_at: rowDate(),
        updated_at: rowDate()
      }]];
      return [[]];
    })
  } as unknown as DatabaseConnection;
}

function writableState(overrides: Partial<AppState> = {}): AppState {
  return {
    booths: [],
    tickets: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    config: defaultConfig(),
    ...overrides
  };
}

function recordingConnection() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const connection = {
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.trimStart().startsWith("SELECT")) return [[]];
      return [{ affectedRows: 1 }];
    })
  } as unknown as DatabaseConnection;
  return { calls, connection };
}

describe("MariaDbStateStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads admin bootstrap records from MariaDB tables", async () => {
    const data = await new MariaDbStateStore().adminBootstrap(fakeConnection());

    expect(data.booths).toEqual([expect.objectContaining({ boothNumber: "A01" })]);
    expect(data.messageRecords).toEqual([expect.objectContaining({ id: "message-1" })]);
    expect(data.people).toEqual([expect.objectContaining({ id: "person-1", groupName: "搭建组" })]);
    expect(data.people[0]).toEqual(expect.objectContaining({
      groupId: "builder",
      groupLocked: true
    }));
    expect(data.chatIdentities).toEqual([expect.objectContaining({ id: "identity-1", personId: "person-1" })]);
    expect(data.conversations).toEqual([expect.objectContaining({ id: "conv-1", linkedPersonIds: ["person-1"] })]);
    expect(data.pendingWorkOrderSessions).toEqual([expect.objectContaining({ id: "pending-1", missingFields: ["phone"] })]);
    expect(data.outboundMessages).toEqual([expect.objectContaining({ id: "outbound-1", status: "pending" })]);
  });

  it("persists people group ids, group snapshots, and group locks", async () => {
    const { calls, connection } = recordingConnection();
    await new MariaDbStateStore().writeState(writableState({
      people: [{
        id: "person-rbac",
        name: "RBAC User",
        phone: "13800138001",
        role: "admin",
        groupId: "admin-group",
        groupName: "Admin Group Snapshot",
        groupLocked: true,
        enabled: true,
        createdAt: "2026-06-13T10:00:00.000Z",
        updatedAt: "2026-06-13T10:00:00.000Z"
      }]
    }), connection);

    const insert = calls.find((call) => call.sql.includes("INSERT INTO people"));
    expect(insert?.sql.replace(/\s+/g, " ")).toContain("group_id, group_name_snapshot, group_locked");
    expect(insert?.params.slice(4, 7)).toEqual(["admin-group", "Admin Group Snapshot", true]);
  });

  it("persists group canAdmin with a false fallback for legacy config", async () => {
    const config = defaultConfig();
    const legacyGroup = {
      id: "legacy-group",
      name: "Legacy Group",
      description: "Legacy config without canAdmin",
      canClaim: false,
      canProcess: false,
      canAccept: false,
      enabled: true
    } as UserGroup;
    config.userGroups = [
      {
        ...config.userGroups![0],
        id: "admin-group",
        canAdmin: true
      },
      legacyGroup
    ];
    const { calls, connection } = recordingConnection();

    await new MariaDbStateStore().writeState(writableState({ config }), connection);

    const inserts = calls.filter((call) => call.sql.includes("INSERT INTO user_groups"));
    expect(inserts.map((call) => call.params[6])).toEqual([true, false]);
  });

  it("wraps access mutations in a database transaction", async () => {
    const { calls, connection } = recordingConnection();
    databaseMocks.setConnection(connection);

    await new MariaDbStateStore().revokeAccountSessions("account-person-1");

    expect(databaseMocks.withDatabaseTransaction).toHaveBeenCalledOnce();
    expect(calls.some((call) =>
      call.sql.includes("auth_version = auth_version + 1")
    )).toBe(true);
    expect(calls.some((call) =>
      call.sql.includes("UPDATE account_sessions")
    )).toBe(true);
  });

  it("synchronizes access roles in the same transaction as saveConfig", async () => {
    const { calls, connection } = recordingConnection();
    databaseMocks.setConnection(connection);
    const config = defaultConfig();
    config.userGroups = [{
      id: "builder",
      name: "Builder",
      description: "",
      canClaim: true,
      canProcess: true,
      canAccept: false,
      canAdmin: false,
      enabled: true
    }];

    await new MariaDbStateStore().saveConfig(config);

    expect(databaseMocks.withDatabaseTransaction).toHaveBeenCalledOnce();
    const roleInsert = calls.find((call) => call.sql.includes("INSERT INTO roles"));
    expect(roleInsert?.params.slice(0, 3)).toEqual([
      "role-builder",
      "Builder",
      "builder"
    ]);
    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO role_permissions") &&
      call.params.includes("ticket.process")
    )).toBe(true);
  });

  it("persists public access role groups and merged config in one transaction", async () => {
    const currentConfig = {
      ...defaultConfig(),
      autoAcceptance: {
        enabled: true,
        timeoutMinutes: 45
      }
    };
    let latestConfigJson = JSON.stringify(currentConfig);
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const connection = {
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("FROM app_config_versions")) {
          return [[{ config_json: latestConfigJson }]];
        }
        if (sql.includes("INSERT INTO app_config_versions")) {
          latestConfigJson = String(params[2]);
          return [{ affectedRows: 1 }];
        }
        if (sql.trimStart().startsWith("SELECT")) return [[]];
        return [{ affectedRows: 1 }];
      })
    } as unknown as DatabaseConnection;
    databaseMocks.setConnection(connection);
    const store = new MariaDbStateStore();
    const groups: UserGroup[] = [{
      id: "admin",
      name: "Administrators",
      description: "Current administrators",
      canClaim: false,
      canProcess: false,
      canAccept: false,
      canAdmin: true,
      enabled: true
    }];

    await store.syncAccessRoles(groups, {
      accountId: "account-admin",
      personId: "person-admin",
      name: "Root Admin",
      phone: "13700137000",
      groupId: "admin",
      groupName: "Administrators",
      permissions: ["admin.access"],
      sessionType: "admin"
    });

    expect(databaseMocks.withDatabaseTransaction).toHaveBeenCalledOnce();
    const groupWrite = calls.find((call) =>
      call.sql.includes("INSERT INTO user_groups")
    );
    expect(groupWrite?.params.slice(0, 8)).toEqual([
      "admin",
      "Administrators",
      "Current administrators",
      false,
      false,
      false,
      true,
      true
    ]);
    const groupDelete = calls.find((call) =>
      call.sql.trim() === "DELETE FROM user_groups"
    );
    expect(groupDelete?.params).toEqual([]);
    const configInsert = calls.find((call) =>
      call.sql.includes("INSERT INTO app_config_versions")
    );
    expect(configInsert).toBeDefined();
    const persistedConfig = JSON.parse(String(configInsert?.params[2]));
    expect(persistedConfig.userGroups).toEqual(groups);
    expect(persistedConfig.autoAcceptance).toEqual({
      enabled: true,
      timeoutMinutes: 45
    });
    await expect(store.getConfig(connection)).resolves.toMatchObject({
      userGroups: groups,
      autoAcceptance: {
        enabled: true,
        timeoutMinutes: 45
      }
    });
    expect(calls.some((call) =>
      call.sql.includes("DELETE FROM issue_types") ||
      call.sql.includes("DELETE FROM message_integrations") ||
      call.sql.includes("DELETE FROM keyword_groups")
    )).toBe(false);
    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO audit_logs")
    )).toBe(true);
  });

  it("synchronizes default access roles when saved config omits user groups", async () => {
    const { calls, connection } = recordingConnection();
    databaseMocks.setConnection(connection);
    const config = defaultConfig();
    delete config.userGroups;

    await new MariaDbStateStore().saveConfig(config);

    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO roles") &&
      call.params.includes("role-builder")
    )).toBe(true);
  });

  it("synchronizes access roles while writing imported state", async () => {
    const { calls, connection } = recordingConnection();
    const config = defaultConfig();
    config.userGroups = [{
      id: "admin",
      name: "Administrators",
      description: "",
      canClaim: false,
      canProcess: false,
      canAccept: false,
      canAdmin: true,
      enabled: true
    }];

    await new MariaDbStateStore().writeState(
      writableState({ config }),
      connection
    );

    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO roles") &&
      call.params.includes("role-admin")
    )).toBe(true);
    expect(calls.some((call) =>
      call.sql.includes("INSERT INTO role_permissions") &&
      call.params.includes("admin.access")
    )).toBe(true);
  });

  it("replaces RBAC state and synthesizes stable accounts for imported people", async () => {
    const { calls, connection } = recordingConnection();
    const config = defaultConfig();
    config.userGroups = [{
      id: "builder",
      name: "Builder",
      description: "",
      canClaim: true,
      canProcess: true,
      canAccept: false,
      canAdmin: false,
      enabled: true
    }];

    await new MariaDbStateStore().writeState(
      writableState({
        config,
        people: [{
          id: "person-imported",
          name: "Imported User",
          phone: "13800138099",
          role: "handler",
          groupId: "builder",
          groupName: "Builder",
          groupLocked: false,
          enabled: true,
          createdAt: "2026-06-14T00:00:00.000Z",
          updatedAt: "2026-06-14T00:00:00.000Z"
        }]
      }),
      connection
    );

    const deleteIndex = (table: string) => calls.findIndex((call) =>
      call.sql.trim() === `DELETE FROM ${table}`
    );
    const peopleDeleteIndex = deleteIndex("people");
    const groupDeleteIndex = deleteIndex("user_groups");

    for (const table of [
      "account_sessions",
      "account_credentials",
      "account_roles",
      "role_permissions",
      "auth_bootstrap_state",
      "accounts",
      "roles"
    ]) {
      const index = deleteIndex(table);
      expect(index, `${table} should be cleared`).toBeGreaterThanOrEqual(0);
      expect(index, `${table} should be cleared before people`).toBeLessThan(peopleDeleteIndex);
      expect(index, `${table} should be cleared before user_groups`).toBeLessThan(groupDeleteIndex);
    }

    const accountInsert = calls.find((call) =>
      call.sql.includes("INSERT INTO accounts")
    );
    expect(accountInsert?.params.slice(0, 5)).toEqual([
      "account-person-imported",
      "person-imported",
      "13800138099",
      true,
      1
    ]);

    const roleLink = calls.find((call) =>
      call.sql.includes("INSERT INTO account_roles") &&
      call.params.includes("account-person-imported")
    );
    expect(roleLink?.params.slice(0, 2)).toEqual([
      "account-person-imported",
      "role-builder"
    ]);
  });

  it("persists bootstrap group changes into versioned app config", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const connection = {
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("FROM user_groups") && sql.includes("ORDER BY id")) {
          return [[{
            id: "admin",
            name: "Administrators",
            description: "",
            can_claim: 0,
            can_process: 0,
            can_accept: 0,
            can_admin: 1,
            enabled: 1
          }]];
        }
        if (sql.includes("WHERE a.id = ?") && sql.includes("permission_code")) {
          return [[{
            account_id: "account-person-admin",
            person_id: "person-admin",
            person_name: "Root Admin",
            phone: "13700137000",
            group_id: "admin",
            group_name: "Administrators",
            permission_code: "admin.access"
          }]];
        }
        if (sql.trimStart().startsWith("SELECT")) return [[]];
        return [{ affectedRows: 1 }];
      })
    } as unknown as DatabaseConnection;
    databaseMocks.setConnection(connection);

    await new MariaDbStateStore().bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });

    const configInsert = calls.find((call) =>
      call.sql.includes("INSERT INTO app_config_versions")
    );
    expect(configInsert).toBeDefined();
    expect(String(configInsert?.params[2])).toContain('"id":"admin"');
    expect(String(configInsert?.params[2])).toContain('"canAdmin":true');
    expect(databaseMocks.withDatabaseTransaction).toHaveBeenCalledOnce();
  });

  it("propagates bootstrap transaction helper failures without issuing writes", async () => {
    const { connection } = recordingConnection();
    databaseMocks.setConnection(connection);
    const transactionError = new Error("transaction rolled back");
    databaseMocks.withDatabaseTransaction.mockRejectedValueOnce(
      transactionError
    );

    await expect(new MariaDbStateStore().bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    })).rejects.toBe(transactionError);

    expect(databaseMocks.withDatabaseTransaction).toHaveBeenCalledOnce();
    expect(connection.execute).not.toHaveBeenCalled();
  });

  it("persists auto acceptance and queues business and processing notifications", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const connection = {
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("FROM app_config_versions")) {
          return [[{
            config_json: JSON.stringify({
              ...defaultConfig(),
              autoAcceptance: { enabled: true, timeoutMinutes: 30 }
            })
          }]];
        }
        if (sql.includes("SELECT id FROM tickets WHERE status = ?")) return [[{ id: "ticket-auto" }]];
        if (sql.includes("FROM tickets WHERE id = ?") && sql.includes("FOR UPDATE")) {
          return [[{
            id: "ticket-auto",
            title: "A01 星河科技 网络",
            booth_number: "A01",
            company_name: "上海星河科技有限公司",
            company_short_name: "星河科技",
            description: "网络断了",
            image_urls: JSON.stringify([]),
            issue_type: "网络",
            submitter_id: "member-1",
            submitter_name: "张三",
            submitter_phone: "13800138000",
            reporter_person_id: null,
            reporter_chat_identity_id: "chat-1",
            source_conversation_id: "conv-site",
            status: "已解决",
            accepted_at: null,
            handler_id: "handler-1",
            handler_name: "网络值班",
            handler_phone: null,
            assignment_group: "网络组",
            urge_count: 0,
            last_urged_at: null,
            urge_level: 0,
            priority_score: 25,
            created_at: new Date("2026-06-05T07:30:00.000Z"),
            updated_at: new Date("2026-06-05T08:00:00.000Z")
          }]];
        }
        if (sql.includes("FROM ticket_feedback_users")) return [[{
          ticket_id: "ticket-auto",
          user_id: "member-1",
          user_name: "张三",
          phone: "13800138000",
          feedback_at: new Date("2026-06-05T07:30:00.000Z")
        }]];
        if (sql.includes("FROM ticket_replies")) return [[]];
        if (sql.includes("FROM ticket_timeline")) return [[{
          id: "timeline-resolved",
          ticket_id: "ticket-auto",
          type: "status-changed",
          body: "状态变更为已解决：已恢复网络",
          created_at: new Date("2026-06-05T08:00:00.000Z"),
          actor_name: "网络值班"
        }]];
        if (sql.includes("FROM ai_decisions")) return [[]];
        if (sql.trim().startsWith("UPDATE tickets")) return [{ affectedRows: 1 }];
        return [{ affectedRows: 1 }];
      })
    } as unknown as DatabaseConnection;

    await new MariaDbStateStore().runAutoAcceptance(connection, new Date("2026-06-05T08:30:00.000Z"));

    expect(calls.some((call) => call.sql.includes("FOR UPDATE"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("UPDATE tickets") && call.params.includes("已关闭") && call.params.includes("已解决"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("INSERT INTO ticket_timeline") && call.params.includes("业务组在 30 分钟内未验收，系统已自动验收通过并关闭工单"))).toBe(true);
    const outboundInserts = calls.filter((call) => call.sql.includes("INSERT INTO outbound_messages"));
    expect(outboundInserts).toHaveLength(2);
    expect(outboundInserts.map((call) => call.params[4])).toEqual(["conv-site", "网络组"]);
  });
});
