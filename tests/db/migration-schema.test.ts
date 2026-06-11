import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "@/lib/db/migrations";

function compactSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

describe("initial MariaDB schema", () => {
  const schema = readFileSync(path.join(process.cwd(), "db", "migrations", "001_initial_schema.sql"), "utf-8");
  const keywordRuleSetSchema = readFileSync(path.join(process.cwd(), "db", "migrations", "002_keyword_rule_sets.sql"), "utf-8");
  const accessSchema = readFileSync(path.join(process.cwd(), "db", "migrations", "003_user_rbac_management.sql"), "utf-8");
  const accessStatements = splitSqlStatements(accessSchema).map(compactSql);

  function accessStatement(prefix: string) {
    const statement = accessStatements.find((candidate) => candidate.startsWith(prefix));
    if (!statement) throw new Error(`Missing migration statement: ${prefix}`);
    return statement;
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

  it("keeps the indexes needed for current query paths", () => {
    expect(schema).toContain("uniq_booth_per_exhibition");
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

  it("adds account, RBAC, credential, and session tables", () => {
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
      expect(accessSchema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    });
    expect(accessSchema).toContain("uniq_chat_identity_person_platform");
    expect(accessSchema).toContain("'ticket.claim'");
    expect(accessSchema).toContain("'ticket.process'");
    expect(accessSchema).toContain("'ticket.accept'");
    expect(accessSchema).toContain("'admin.access'");
    expect(accessSchema).toContain("idx_account_sessions_lookup (token_hash, session_type, auth_version, revoked_at, expires_at)");
  });

  it("adds every column required for import preview and conflict decisions", () => {
    const importJobs = accessStatement("ALTER TABLE import_jobs");
    expect(importJobs).toContain("ADD COLUMN owner_account_id varchar(128) NULL");
    expect(importJobs).toContain("ADD COLUMN source_hash char(64) NULL");
    expect(importJobs).toContain("ADD COLUMN preview_version varchar(64) NULL");
    expect(importJobs).toContain("ADD COLUMN updated_at datetime(3) NULL");

    const importJobRows = accessStatement("ALTER TABLE import_job_rows");
    expect(importJobRows).toContain("ADD COLUMN normalized_payload json NULL");
    expect(importJobRows).toContain("ADD COLUMN conflict_json json NULL");
    expect(importJobRows).toContain("ADD COLUMN decision_json json NULL");
    expect(importJobRows).toContain("ADD COLUMN result_action varchar(32) NULL");
    expect(importJobRows).toContain("ADD COLUMN updated_at datetime(3) NULL");
  });

  it("keeps RBAC identifiers and opaque hashes at their required widths", () => {
    expect(accessStatement("CREATE TABLE IF NOT EXISTS accounts")).toContain("id varchar(128) NOT NULL PRIMARY KEY");
    expect(accessStatement("CREATE TABLE IF NOT EXISTS accounts")).toContain("person_id varchar(64) NOT NULL");
    expect(accessStatement("CREATE TABLE IF NOT EXISTS accounts")).toContain("login_name varchar(64) NOT NULL");
    expect(accessStatement("CREATE TABLE IF NOT EXISTS account_credentials")).toContain("account_id varchar(128) NOT NULL PRIMARY KEY");
    expect(accessStatement("CREATE TABLE IF NOT EXISTS roles")).toContain("id varchar(128) NOT NULL PRIMARY KEY");
    expect(accessStatement("CREATE TABLE IF NOT EXISTS roles")).toContain("source_group_id varchar(64) NOT NULL");
    expect(accessStatement("CREATE TABLE IF NOT EXISTS account_roles")).toContain("account_id varchar(128) NOT NULL");
    expect(accessStatement("CREATE TABLE IF NOT EXISTS account_roles")).toContain("role_id varchar(128) NOT NULL");
    expect(accessStatement("CREATE TABLE IF NOT EXISTS role_permissions")).toContain("permission_code varchar(64) NOT NULL");
    expect(accessStatement("CREATE TABLE IF NOT EXISTS account_sessions")).toContain("account_id varchar(128) NOT NULL");
    expect(accessStatement("CREATE TABLE IF NOT EXISTS account_sessions")).toContain("token_hash char(64) NOT NULL");
    expect(accessStatement("CREATE TABLE IF NOT EXISTS auth_bootstrap_state")).toContain("completed_by_account_id varchar(128) NULL");
  });

  it("backfills groups, accounts, and one group-derived role per account", () => {
    const groupSnapshotBackfill = accessStatement("UPDATE people p");
    expect(groupSnapshotBackfill).toContain("p.group_name_snapshot = g.name");
    expect(groupSnapshotBackfill).toContain("SET p.group_id = g.id");

    const fallbackGroupBackfill = accessStatement("UPDATE people SET group_id");
    expect(fallbackGroupBackfill).toContain("WHERE fallback_group.enabled = true");
    expect(fallbackGroupBackfill).toContain("ORDER BY fallback_group.created_at, fallback_group.id LIMIT 1");
    expect(fallbackGroupBackfill).toContain("WHERE group_id IS NULL");

    const accountBackfill = accessStatement("INSERT IGNORE INTO accounts");
    expect(accountBackfill).toContain("SELECT CONCAT('account-', id), id, phone, enabled, 1, NULL, created_at, updated_at FROM people");

    const accountRoleBackfill = accessStatement("INSERT IGNORE INTO account_roles");
    expect(accountRoleBackfill).toContain("SELECT CONCAT('account-', p.id), CONCAT('role-', p.group_id), p.updated_at FROM people p");
    expect(accountRoleBackfill).toContain("WHERE p.group_id IS NOT NULL");
  });

  it("seeds the complete fixed permission catalog in stable order", () => {
    const permissionSeed = accessStatement("INSERT IGNORE INTO permissions");
    const seededCodes = [...permissionSeed.matchAll(/\('([^']+)',\s*'[^']+'\)/g)].map((match) => match[1]);

    expect(seededCodes).toEqual([
      "ticket.claim",
      "ticket.process",
      "ticket.accept",
      "admin.access"
    ]);
  });

  it("clears later duplicate identity bindings before adding the person-platform constraint", () => {
    const dedupeStatement = accessStatement("UPDATE chat_identities duplicate_identity");
    expect(dedupeStatement).toContain("duplicate_identity.person_id = keeper.person_id");
    expect(dedupeStatement).toContain("duplicate_identity.platform = keeper.platform");
    expect(dedupeStatement).toContain("duplicate_identity.id > keeper.id");
    expect(dedupeStatement).toContain("SET duplicate_identity.person_id = NULL, duplicate_identity.verified_by = NULL, duplicate_identity.verified_at = NULL");
    expect(dedupeStatement).toContain("WHERE duplicate_identity.person_id IS NOT NULL");

    const uniqueConstraintIndex = accessStatements.findIndex((statement) => statement.startsWith("ALTER TABLE chat_identities"));
    const dedupeIndex = accessStatements.indexOf(dedupeStatement);
    expect(dedupeIndex).toBeGreaterThanOrEqual(0);
    expect(uniqueConstraintIndex).toBeGreaterThan(dedupeIndex);
    expect(accessStatements[uniqueConstraintIndex]).toContain("ADD UNIQUE KEY uniq_chat_identity_person_platform (person_id, platform)");
  });
});
