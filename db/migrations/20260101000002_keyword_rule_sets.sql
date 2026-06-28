-- migrate:up transaction:false
CREATE TABLE IF NOT EXISTS keyword_rule_sets (
  id varchar(64) NOT NULL PRIMARY KEY,
  group_id varchar(64) NOT NULL,
  match_type varchar(32) NOT NULL,
  action varchar(32) NOT NULL,
  issue_type varchar(120) NULL,
  priority int NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  channels json NULL,
  conditions_json json NULL,
  action_config_json json NULL,
  sort_order int NOT NULL DEFAULT 0,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  KEY idx_keyword_rule_sets_group (group_id, enabled, priority),
  KEY idx_keyword_rule_sets_action (action, issue_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS keyword_terms (
  id varchar(64) NOT NULL PRIMARY KEY,
  rule_set_id varchar(64) NOT NULL,
  term varchar(120) NOT NULL,
  aliases json NULL,
  enabled boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_keyword_term_per_rule_set (rule_set_id, term),
  KEY idx_keyword_terms_rule_set (rule_set_id, enabled, sort_order),
  KEY idx_keyword_terms_term (term)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS keyword_match_logs (
  id varchar(128) NOT NULL PRIMARY KEY,
  inbound_message_id varchar(64) NULL,
  channel varchar(16) NOT NULL,
  group_id varchar(64) NOT NULL,
  rule_set_id varchar(64) NOT NULL,
  term_id varchar(64) NULL,
  term varchar(120) NOT NULL,
  action varchar(32) NOT NULL,
  issue_type varchar(120) NULL,
  ticket_id varchar(64) NULL,
  created_at datetime(3) NOT NULL,
  KEY idx_keyword_match_logs_message (inbound_message_id),
  KEY idx_keyword_match_logs_rule_set (rule_set_id),
  KEY idx_keyword_match_logs_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO keyword_rule_sets (
  id, group_id, match_type, action, issue_type, priority, enabled,
  channels, conditions_json, action_config_json, sort_order, created_at, updated_at
)
SELECT
  CONCAT('krs-', LEFT(MD5(CONCAT_WS('|', group_id, match_type, action, COALESCE(issue_type, ''), priority, enabled)), 24)),
  group_id,
  match_type,
  action,
  issue_type,
  priority,
  enabled,
  NULL,
  NULL,
  NULL,
  MAX(priority),
  MIN(created_at),
  MAX(updated_at)
FROM keyword_rules
GROUP BY group_id, match_type, action, issue_type, priority, enabled;

INSERT IGNORE INTO keyword_terms (
  id, rule_set_id, term, aliases, enabled, sort_order, created_at, updated_at
)
SELECT
  id,
  CONCAT('krs-', LEFT(MD5(CONCAT_WS('|', group_id, match_type, action, COALESCE(issue_type, ''), priority, enabled)), 24)),
  keyword,
  NULL,
  enabled,
  priority,
  created_at,
  updated_at
FROM keyword_rules;
-- migrate:down transaction:false
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'Historical migration cannot be rolled back automatically';
