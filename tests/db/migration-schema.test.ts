import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "@/lib/db/migrations";

describe("MariaDB migration schema", () => {
  const schema = readFileSync(path.join(process.cwd(), "db", "migrations", "001_initial_schema.sql"), "utf-8");
  const keywordRuleSetSchema = readFileSync(path.join(process.cwd(), "db", "migrations", "002_keyword_rule_sets.sql"), "utf-8");
  const wxautoSchema = readFileSync(path.join(process.cwd(), "db", "migrations", "003_wxauto_mcp.sql"), "utf-8");
  const wxautoStateLockSchema = readFileSync(path.join(process.cwd(), "db", "migrations", "004_wxauto_state_lock.sql"), "utf-8");

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

  it("adds durable wxauto MCP agent, receipt, attempt and release storage", () => {
    const outboundAlterFragments = [
      "ALTER TABLE outbound_messages",
      "ADD COLUMN claimed_by_agent_id varchar(128) NULL AFTER claimed_at",
      "ADD COLUMN lease_id varchar(64) NULL AFTER claimed_by_agent_id",
      "ADD COLUMN lease_expires_at datetime(3) NULL AFTER lease_id",
      "ADD COLUMN safety_rule varchar(120) NULL AFTER last_error",
      "ADD UNIQUE KEY uniq_outbound_lease (lease_id)",
      "ADD KEY idx_outbound_agent_lease (claimed_by_agent_id, lease_expires_at)",
      "ADD KEY idx_outbound_lease_expiry (status, lease_expires_at, created_at)"
    ];

    [
      "wxauto_agents",
      "wxauto_event_receipts",
      "outbound_message_attempts",
      "wxauto_releases"
    ].forEach((table) => {
      expect(wxautoSchema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    });
    expect(wxautoSchema).toContain("lease_id varchar(64) NULL");
    expect(wxautoSchema).toContain("lease_expires_at datetime(3) NULL");
    expect(wxautoSchema).toContain("uniq_wxauto_event");
    expect(wxautoSchema).toContain("uniq_outbound_attempt_lease");

    outboundAlterFragments.forEach((fragment) => {
      expect(wxautoSchema).toContain(fragment);
    });

    const statements = splitSqlStatements(wxautoSchema);
    expect(statements).toHaveLength(5);
    const outboundAlter = statements.find((statement) => statement.includes("ALTER TABLE outbound_messages"));
    expect(outboundAlter).toBeDefined();
    outboundAlterFragments.forEach((fragment) => {
      expect(outboundAlter).toContain(fragment);
    });
  });

  it("initializes the wxauto state-write transaction lock", () => {
    expect(wxautoStateLockSchema).toContain("CREATE TABLE IF NOT EXISTS wxauto_integration_locks");
    expect(wxautoStateLockSchema).toContain("name varchar(64) NOT NULL PRIMARY KEY");
    expect(wxautoStateLockSchema).toContain("updated_at datetime(3) NOT NULL");
    expect(wxautoStateLockSchema).toContain("ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    expect(wxautoStateLockSchema).toContain("INSERT IGNORE INTO wxauto_integration_locks");
    expect(wxautoStateLockSchema).toContain("'state-write'");
    expect(wxautoStateLockSchema).toContain("CURRENT_TIMESTAMP(3)");

    const statements = splitSqlStatements(wxautoStateLockSchema);
    expect(statements).toHaveLength(2);
    expect(statements[1]).toContain("INSERT IGNORE INTO wxauto_integration_locks");
    expect(statements[1]).toContain("'state-write'");
  });
});
