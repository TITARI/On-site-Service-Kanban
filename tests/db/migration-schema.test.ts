import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "@/lib/db/migrations";

function normalizeSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

describe("initial MariaDB schema", () => {
  const schema = readFileSync(path.join(process.cwd(), "db", "migrations", "001_initial_schema.sql"), "utf-8");
  const keywordRuleSetSchema = readFileSync(path.join(process.cwd(), "db", "migrations", "002_keyword_rule_sets.sql"), "utf-8");
  const rbacSchemaPath = path.join(process.cwd(), "db", "migrations", "003_user_rbac_management.sql");
  const rbacSchema = existsSync(rbacSchemaPath) ? readFileSync(rbacSchemaPath, "utf-8") : "";
  const ticketOptimisticLockSchemaPath = path.join(process.cwd(), "db", "migrations", "005_ticket_optimistic_lock.sql");
  const ticketOptimisticLockSchema = existsSync(ticketOptimisticLockSchemaPath)
    ? readFileSync(ticketOptimisticLockSchemaPath, "utf-8")
    : "";
  const bootstrapRateLimitSchemaPath = path.join(process.cwd(), "db", "migrations", "006_bootstrap_rate_limits.sql");
  const bootstrapRateLimitSchema = existsSync(bootstrapRateLimitSchemaPath)
    ? readFileSync(bootstrapRateLimitSchemaPath, "utf-8")
    : "";
  const sessionKindSchemaPath = path.join(process.cwd(), "db", "migrations", "008_session_kind.sql");
  const sessionKindSchema = existsSync(sessionKindSchemaPath)
    ? readFileSync(sessionKindSchemaPath, "utf-8")
    : "";
  const userVersionSchemaPath = path.join(process.cwd(), "db", "migrations", "009_user_version_column.sql");
  const userVersionSchema = existsSync(userVersionSchemaPath)
    ? readFileSync(userVersionSchemaPath, "utf-8")
    : "";
  const normalizedRbacSchema = normalizeSql(rbacSchema);
  const normalizedTicketOptimisticLockSchema = normalizeSql(ticketOptimisticLockSchema);
  const normalizedBootstrapRateLimitSchema = normalizeSql(bootstrapRateLimitSchema);
  const normalizedSessionKindSchema = normalizeSql(sessionKindSchema);
  const normalizedUserVersionSchema = normalizeSql(userVersionSchema);

  function tableDefinition(table: string) {
    const match = rbacSchema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\) ENGINE=`));
    return normalizeSql(match?.[1] ?? "");
  }

  function alterTableDefinition(table: string) {
    const match = rbacSchema.match(new RegExp(`ALTER TABLE ${table}([\\s\\S]*?);`));
    return normalizeSql(match?.[1] ?? "");
  }

  function varcharWidth(definition: string, column: string) {
    const match = definition.match(new RegExp(`\\b${column} varchar\\((\\d+)\\)`));
    return Number(match?.[1] ?? Number.NaN);
  }

  it("creates the core tables required by the database design", () => {
    [
      "exhibitions",
      "exhibition_booths",
      "tickets",
      "ticket_feedback_users",
      "ticket_replies",
      "ticket_timeline",
      "ai_decisions",
      "inbound_messages",
      "message_analysis_logs",
      "wechat_order_logs",
      "pending_work_order_sessions",
      "outbound_messages",
      "issue_types",
      "assignment_rules",
      "message_integrations",
      "ai_model_configs",
      "keyword_groups",
      "keyword_rules",
      "app_config_versions",
      "audit_logs",
      "import_jobs",
      "import_job_rows"
    ].forEach((table) => {
      expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    });
  });

  it("creates persistent bootstrap rate limits keyed by client IP", () => {
    expect(normalizedBootstrapRateLimitSchema).toContain(normalizeSql(`
      CREATE TABLE IF NOT EXISTS bootstrap_rate_limits (
        ip_key varchar(255) NOT NULL,
        attempts int unsigned NOT NULL,
        reset_at datetime(3) NOT NULL,
        PRIMARY KEY (ip_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `));
  });

  it("adds and backfills pending work order session kinds", () => {
    expect(normalizedSessionKindSchema).toContain(normalizeSql(`
      ALTER TABLE pending_work_order_sessions ADD COLUMN session_kind VARCHAR(20) NULL;
    `));
    expect(normalizedSessionKindSchema).toContain(normalizeSql(`
      UPDATE pending_work_order_sessions
      SET session_kind = 'handler-reply'
      WHERE issue_type = '__handler-reply';
    `));
    expect(normalizedSessionKindSchema).toContain(normalizeSql(`
      UPDATE pending_work_order_sessions
      SET session_kind = 'work-order'
      WHERE issue_type <> '__handler-reply' OR issue_type IS NULL;
    `));
  });

  it("keeps the indexes needed for current query paths", () => {
    expect(schema).toContain("uniq_booth_exhibitor_per_exhibition");
    expect(schema).toContain("(exhibition_id, booth_number, company_name)");
    expect(schema).toContain("idx_tickets_status_priority");
    expect(schema).toContain("uniq_inbound_external_message");
    expect(schema).toContain("idx_outbound_claim");
    expect(schema).toContain("idx_keyword_rules_keyword");
  });

  it("escapes import job row columns that are reserved in MariaDB 11", () => {
    expect(schema).toContain("`row_number` int NOT NULL");
  });

  it("adds rule-set based keyword tables for many terms per rule", () => {
    expect(keywordRuleSetSchema).toContain("CREATE TABLE IF NOT EXISTS keyword_rule_sets");
    expect(keywordRuleSetSchema).toContain("CREATE TABLE IF NOT EXISTS keyword_terms");
    expect(keywordRuleSetSchema).toContain("CREATE TABLE IF NOT EXISTS keyword_match_logs");
    expect(keywordRuleSetSchema).toContain("INSERT IGNORE INTO keyword_rule_sets");
    expect(keywordRuleSetSchema).toContain("INSERT IGNORE INTO keyword_terms");
    expect(keywordRuleSetSchema).toContain("uniq_keyword_term_per_rule_set");
    expect(keywordRuleSetSchema).toContain("idx_keyword_match_logs_message");
  });

  it("adds the account and RBAC management tables", () => {
    [
      "accounts",
      "account_credentials",
      "roles",
      "account_roles",
      "permissions",
      "role_permissions",
      "account_sessions",
      "auth_bootstrap_state"
    ].forEach((table) => {
      expect(rbacSchema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    });
  });

  it("adds the exact people group lock column", () => {
    expect(alterTableDefinition("people")).toBe(normalizeSql(`
      ADD COLUMN IF NOT EXISTS group_locked boolean NOT NULL DEFAULT false AFTER group_name_snapshot
    `));
  });

  it("keeps every Task 1 ALTER addition restart-safe and independently splittable", () => {
    const alterStatements = splitSqlStatements(rbacSchema)
      .filter((statement) => statement.startsWith("ALTER TABLE"))
      .map(normalizeSql);

    expect(alterStatements).toEqual([
      normalizeSql(`
        ALTER TABLE people
          ADD COLUMN IF NOT EXISTS group_locked boolean NOT NULL DEFAULT false AFTER group_name_snapshot
      `),
      normalizeSql(`
        ALTER TABLE chat_identities
          ADD UNIQUE KEY IF NOT EXISTS uniq_chat_identity_person_platform (person_id, platform)
      `),
      normalizeSql(`
        ALTER TABLE import_jobs
          ADD COLUMN IF NOT EXISTS owner_account_id varchar(128) NULL,
          ADD COLUMN IF NOT EXISTS source_hash char(64) NULL,
          ADD COLUMN IF NOT EXISTS preview_version varchar(64) NULL,
          ADD COLUMN IF NOT EXISTS updated_at datetime(3) NULL
      `),
      normalizeSql(`
        ALTER TABLE import_job_rows
          ADD COLUMN IF NOT EXISTS normalized_payload json NULL,
          ADD COLUMN IF NOT EXISTS conflict_json json NULL,
          ADD COLUMN IF NOT EXISTS decision_json json NULL,
          ADD COLUMN IF NOT EXISTS result_action varchar(32) NULL,
          ADD COLUMN IF NOT EXISTS updated_at datetime(3) NULL
      `)
    ]);
  });

  it("uses the exact account, credential, role, permission, session, and bootstrap definitions", () => {
    expect(tableDefinition("accounts")).toBe(normalizeSql(`
      id varchar(128) NOT NULL PRIMARY KEY,
      person_id varchar(64) NOT NULL,
      login_name varchar(64) NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      auth_version int NOT NULL DEFAULT 1,
      last_login_at datetime(3) NULL,
      created_at datetime(3) NOT NULL,
      updated_at datetime(3) NOT NULL,
      UNIQUE KEY uniq_accounts_person (person_id),
      UNIQUE KEY uniq_accounts_login_name (login_name),
      KEY idx_accounts_enabled (enabled)
    `));
    expect(tableDefinition("account_credentials")).toBe(normalizeSql(`
      account_id varchar(128) NOT NULL PRIMARY KEY,
      password_hash varchar(255) NOT NULL,
      password_changed_at datetime(3) NOT NULL,
      must_change_password boolean NOT NULL DEFAULT false,
      failed_attempts int NOT NULL DEFAULT 0,
      locked_until datetime(3) NULL
    `));
    expect(tableDefinition("roles")).toBe(normalizeSql(`
      id varchar(128) NOT NULL PRIMARY KEY,
      name varchar(120) NOT NULL,
      source_group_id varchar(64) NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      created_at datetime(3) NOT NULL,
      updated_at datetime(3) NOT NULL,
      UNIQUE KEY uniq_roles_source_group (source_group_id)
    `));
    expect(tableDefinition("permissions")).toBe(normalizeSql(`
      code varchar(64) NOT NULL PRIMARY KEY,
      name varchar(120) NOT NULL
    `));
    expect(tableDefinition("account_roles")).toBe(normalizeSql(`
      account_id varchar(128) NOT NULL,
      role_id varchar(128) NOT NULL,
      created_at datetime(3) NOT NULL,
      PRIMARY KEY (account_id, role_id),
      UNIQUE KEY uniq_account_single_role (account_id)
    `));
    expect(tableDefinition("role_permissions")).toBe(normalizeSql(`
      role_id varchar(128) NOT NULL,
      permission_code varchar(64) NOT NULL,
      created_at datetime(3) NOT NULL,
      PRIMARY KEY (role_id, permission_code)
    `));
    expect(tableDefinition("account_sessions")).toBe(normalizeSql(`
      id varchar(64) NOT NULL PRIMARY KEY,
      account_id varchar(128) NOT NULL,
      session_type varchar(16) NOT NULL,
      token_hash char(64) NOT NULL,
      auth_version int NOT NULL,
      expires_at datetime(3) NOT NULL,
      last_seen_at datetime(3) NOT NULL,
      revoked_at datetime(3) NULL,
      created_at datetime(3) NOT NULL,
      UNIQUE KEY uniq_account_session_token (token_hash),
      KEY idx_account_sessions_lookup (token_hash, session_type, revoked_at, expires_at),
      KEY idx_account_sessions_account (account_id, revoked_at)
    `));
    expect(tableDefinition("auth_bootstrap_state")).toBe(normalizeSql(`
      id varchar(32) NOT NULL PRIMARY KEY,
      completed_at datetime(3) NULL,
      completed_by_account_id varchar(128) NULL
    `));
  });

  it("backfills groups and role timestamps from deterministic source rows", () => {
    expect(normalizedRbacSchema).toContain(normalizeSql(`
      UPDATE people p
      JOIN user_groups g ON p.group_id IS NULL AND p.group_name_snapshot = g.name
      SET p.group_id = g.id;
    `));
    expect(normalizedRbacSchema).toContain(normalizeSql(`
      UPDATE people
      SET group_id = (
        SELECT fallback_group.id
        FROM user_groups fallback_group
        WHERE fallback_group.enabled = true
        ORDER BY fallback_group.created_at, fallback_group.id
        LIMIT 1
      )
      WHERE group_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM user_groups g WHERE g.id = people.group_id
        );
    `));
    expect(normalizedRbacSchema).toContain(normalizeSql(`
      INSERT IGNORE INTO roles (
        id,
        name,
        source_group_id,
        enabled,
        created_at,
        updated_at
      )
      SELECT
        CONCAT('role-', id),
        name,
        id,
        enabled,
        created_at,
        updated_at
      FROM user_groups;
    `));
    expect(normalizedRbacSchema).toContain(normalizeSql(`
      INSERT IGNORE INTO role_permissions (role_id, permission_code, created_at)
      SELECT CONCAT('role-', id), 'ticket.claim', updated_at FROM user_groups WHERE can_claim = true
      UNION ALL
      SELECT CONCAT('role-', id), 'ticket.process', updated_at FROM user_groups WHERE can_process = true
      UNION ALL
      SELECT CONCAT('role-', id), 'ticket.accept', updated_at FROM user_groups WHERE can_accept = true
      UNION ALL
      SELECT CONCAT('role-', id), 'admin.access', updated_at FROM user_groups WHERE can_admin = true;
    `));
    expect(normalizedRbacSchema).toContain(normalizeSql(`
      INSERT IGNORE INTO accounts (
        id,
        person_id,
        login_name,
        enabled,
        auth_version,
        last_login_at,
        created_at,
        updated_at
      )
      SELECT
        CONCAT('account-', id),
        id,
        phone,
        enabled,
        1,
        NULL,
        created_at,
        updated_at
      FROM people;
    `));
    expect(normalizedRbacSchema).toContain(normalizeSql(`
      INSERT IGNORE INTO account_roles (account_id, role_id, created_at)
      SELECT CONCAT('account-', p.id), CONCAT('role-', p.group_id), p.updated_at
      FROM people p
      WHERE p.group_id IS NOT NULL;
    `));
  });

  it("preserves duplicate chat identity rows while clearing duplicate bindings", () => {
    expect(normalizedRbacSchema).toContain(normalizeSql(`
      UPDATE chat_identities duplicate_identity
      JOIN chat_identities keeper
        ON duplicate_identity.person_id = keeper.person_id
       AND duplicate_identity.platform = keeper.platform
       AND duplicate_identity.id > keeper.id
      SET duplicate_identity.person_id = NULL,
          duplicate_identity.verified_by = NULL,
          duplicate_identity.verified_at = NULL
      WHERE duplicate_identity.person_id IS NOT NULL
        AND keeper.person_id IS NOT NULL;
    `));
    expect(normalizedRbacSchema).not.toContain("DELETE duplicate_identity");
    expect(rbacSchema).toContain("uniq_chat_identity_person_platform");
  });

  it("adds exact nullable import preview columns", () => {
    expect(alterTableDefinition("import_jobs")).toBe(normalizeSql(`
      ADD COLUMN IF NOT EXISTS owner_account_id varchar(128) NULL,
      ADD COLUMN IF NOT EXISTS source_hash char(64) NULL,
      ADD COLUMN IF NOT EXISTS preview_version varchar(64) NULL,
      ADD COLUMN IF NOT EXISTS updated_at datetime(3) NULL
    `));
    expect(alterTableDefinition("import_job_rows")).toBe(normalizeSql(`
      ADD COLUMN IF NOT EXISTS normalized_payload json NULL,
      ADD COLUMN IF NOT EXISTS conflict_json json NULL,
      ADD COLUMN IF NOT EXISTS decision_json json NULL,
      ADD COLUMN IF NOT EXISTS result_action varchar(32) NULL,
      ADD COLUMN IF NOT EXISTS updated_at datetime(3) NULL
    `));
  });

  it("keeps import job owner ids as wide as account ids", () => {
    expect(varcharWidth(alterTableDefinition("import_jobs"), "owner_account_id"))
      .toBe(varcharWidth(tableDefinition("accounts"), "id"));
  });

  it("seeds the exact permission codes and labels", () => {
    expect(normalizedRbacSchema).toContain(normalizeSql(`
      INSERT IGNORE INTO permissions (code, name) VALUES
        ('ticket.claim', '认领工单'),
        ('ticket.process', '处理工单'),
        ('ticket.accept', '验收工单'),
        ('admin.access', '后台管理');
    `));
  });

  it("adds ticket graph columns needed for incremental patch persistence", () => {
    expect(normalizedTicketOptimisticLockSchema).toContain(normalizeSql(`
      ALTER TABLE tickets
        ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0
    `));
    expect(normalizedTicketOptimisticLockSchema).toContain(normalizeSql(`
      ALTER TABLE ticket_timeline
        ADD COLUMN IF NOT EXISTS to_status VARCHAR(20) NULL
    `));
    expect(normalizedTicketOptimisticLockSchema).toContain(normalizeSql(`
      ALTER TABLE ai_decisions
        ADD COLUMN IF NOT EXISTS provider VARCHAR(8) NOT NULL DEFAULT 'mock'
    `));
  });

  it("adds monotonic version columns for people and accounts", () => {
    expect(normalizedUserVersionSchema).toContain(normalizeSql(`
      ALTER TABLE people
        ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0
    `));
    expect(normalizedUserVersionSchema).toContain(normalizeSql(`
      ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0
    `));
  });
});
