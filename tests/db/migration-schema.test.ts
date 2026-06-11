import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("initial MariaDB schema", () => {
  const schema = readFileSync(path.join(process.cwd(), "db", "migrations", "001_initial_schema.sql"), "utf-8");
  const keywordRuleSetSchema = readFileSync(path.join(process.cwd(), "db", "migrations", "002_keyword_rule_sets.sql"), "utf-8");
  const accessSchema = readFileSync(path.join(process.cwd(), "db", "migrations", "003_user_rbac_management.sql"), "utf-8");

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
});
