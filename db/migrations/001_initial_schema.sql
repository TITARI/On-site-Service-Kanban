CREATE TABLE IF NOT EXISTS schema_migrations (
  version varchar(64) NOT NULL PRIMARY KEY,
  applied_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS exhibitions (
  id varchar(64) NOT NULL PRIMARY KEY,
  name varchar(160) NOT NULL,
  status varchar(32) NOT NULL,
  starts_at datetime(3) NULL,
  ends_at datetime(3) NULL,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  KEY idx_exhibitions_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS exhibition_booths (
  id varchar(64) NOT NULL PRIMARY KEY,
  exhibition_id varchar(64) NOT NULL,
  booth_number varchar(64) NOT NULL,
  company_name varchar(255) NOT NULL,
  company_short_name varchar(120) NULL,
  sales_owner varchar(120) NULL,
  builder varchar(160) NULL,
  contact_name varchar(120) NULL,
  contact_phone varchar(64) NULL,
  raw_payload json NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_booth_exhibitor_per_exhibition (exhibition_id, booth_number, company_name),
  KEY idx_booths_company (company_name),
  KEY idx_booths_builder (builder),
  KEY idx_booths_sales_owner (sales_owner)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_groups (
  id varchar(64) NOT NULL PRIMARY KEY,
  name varchar(120) NOT NULL,
  description varchar(255) NOT NULL,
  can_claim boolean NOT NULL DEFAULT false,
  can_process boolean NOT NULL DEFAULT false,
  can_accept boolean NOT NULL DEFAULT false,
  can_admin boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_user_groups_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS people (
  id varchar(64) NOT NULL PRIMARY KEY,
  name varchar(120) NOT NULL,
  phone varchar(64) NOT NULL,
  role varchar(32) NOT NULL,
  group_id varchar(64) NULL,
  group_name_snapshot varchar(120) NULL,
  name_conflict json NULL,
  booth_scope json NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_people_phone (phone),
  KEY idx_people_group (group_id),
  KEY idx_people_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_identities (
  id varchar(64) NOT NULL PRIMARY KEY,
  platform varchar(16) NOT NULL,
  external_user_id varchar(160) NOT NULL,
  display_name varchar(160) NOT NULL,
  is_temporary boolean NOT NULL DEFAULT false,
  person_id varchar(64) NULL,
  verified_by varchar(32) NULL,
  verified_at datetime(3) NULL,
  first_seen_at datetime(3) NOT NULL,
  last_seen_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_chat_identity (platform, external_user_id),
  KEY idx_chat_identity_person (person_id),
  KEY idx_chat_identity_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversations (
  id varchar(64) NOT NULL PRIMARY KEY,
  platform varchar(16) NOT NULL,
  type varchar(16) NOT NULL,
  external_conversation_id varchar(160) NOT NULL,
  title varchar(160) NULL,
  default_notify boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_conversation (platform, external_conversation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversation_people (
  conversation_id varchar(64) NOT NULL,
  person_id varchar(64) NOT NULL,
  created_at datetime(3) NOT NULL,
  PRIMARY KEY pk_conversation_people (conversation_id, person_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tickets (
  id varchar(64) NOT NULL PRIMARY KEY,
  title varchar(255) NOT NULL,
  booth_number varchar(64) NOT NULL,
  company_name varchar(255) NOT NULL,
  company_short_name varchar(120) NOT NULL,
  description text NOT NULL,
  image_urls json NOT NULL,
  issue_type varchar(120) NOT NULL,
  submitter_id varchar(120) NOT NULL,
  submitter_name varchar(120) NOT NULL,
  submitter_phone varchar(64) NULL,
  reporter_person_id varchar(64) NULL,
  reporter_chat_identity_id varchar(64) NULL,
  source_conversation_id varchar(160) NULL,
  status varchar(32) NOT NULL,
  accepted_at datetime(3) NULL,
  handler_id varchar(64) NULL,
  handler_name varchar(120) NULL,
  handler_phone varchar(64) NULL,
  assignment_group varchar(120) NULL,
  urge_count int NOT NULL DEFAULT 0,
  last_urged_at datetime(3) NULL,
  urge_level tinyint NOT NULL DEFAULT 0,
  priority_score int NOT NULL DEFAULT 0,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  KEY idx_tickets_status_priority (status, priority_score, updated_at),
  KEY idx_tickets_booth (booth_number),
  KEY idx_tickets_issue_type (issue_type),
  KEY idx_tickets_assignment_group (assignment_group),
  KEY idx_tickets_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_feedback_users (
  id varchar(128) NOT NULL PRIMARY KEY,
  ticket_id varchar(64) NOT NULL,
  user_id varchar(120) NOT NULL,
  user_name varchar(120) NOT NULL,
  phone varchar(64) NULL,
  feedback_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_ticket_feedback_user (ticket_id, user_id),
  KEY idx_feedback_ticket (ticket_id),
  KEY idx_feedback_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_replies (
  id varchar(64) NOT NULL PRIMARY KEY,
  ticket_id varchar(64) NOT NULL,
  author_id varchar(120) NOT NULL,
  author_name varchar(120) NOT NULL,
  author_phone varchar(64) NULL,
  role varchar(32) NOT NULL,
  body text NOT NULL,
  image_urls json NOT NULL,
  created_at datetime(3) NOT NULL,
  KEY idx_ticket_replies_ticket (ticket_id),
  KEY idx_ticket_replies_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_timeline (
  id varchar(64) NOT NULL PRIMARY KEY,
  ticket_id varchar(64) NOT NULL,
  type varchar(32) NOT NULL,
  body text NOT NULL,
  actor_name varchar(120) NOT NULL,
  created_at datetime(3) NOT NULL,
  KEY idx_ticket_timeline_ticket (ticket_id),
  KEY idx_ticket_timeline_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_decisions (
  id varchar(128) NOT NULL PRIMARY KEY,
  ticket_id varchar(64) NOT NULL,
  model_id varchar(32) NOT NULL,
  scenario varchar(32) NOT NULL,
  confidence decimal(5,4) NOT NULL DEFAULT 0,
  action varchar(32) NOT NULL,
  issue_type varchar(120) NULL,
  matched_ticket_id varchar(64) NULL,
  suggestion text NULL,
  latency_ms int NOT NULL DEFAULT 0,
  created_at datetime(3) NOT NULL,
  KEY idx_ai_decisions_ticket (ticket_id),
  KEY idx_ai_decisions_scenario (scenario)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inbound_messages (
  id varchar(64) NOT NULL PRIMARY KEY,
  channel varchar(16) NOT NULL,
  external_message_id varchar(160) NULL,
  sender_id varchar(160) NULL,
  sender_name varchar(160) NOT NULL,
  sender_phone varchar(64) NULL,
  sender_group varchar(160) NULL,
  text text NOT NULL,
  image_urls json NOT NULL,
  received_at datetime(3) NOT NULL,
  created_at datetime(3) NOT NULL,
  reporter_person_id varchar(64) NULL,
  reporter_chat_identity_id varchar(64) NULL,
  source_conversation_id varchar(160) NULL,
  raw_payload json NULL,
  analysis_json json NOT NULL,
  UNIQUE KEY uniq_inbound_external_message (channel, external_message_id),
  KEY idx_inbound_received (received_at),
  KEY idx_inbound_channel_created (channel, created_at),
  KEY idx_inbound_sender (sender_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_analysis_logs (
  id varchar(128) NOT NULL PRIMARY KEY,
  inbound_message_id varchar(64) NOT NULL,
  booth_number varchar(64) NULL,
  issue_type varchar(120) NULL,
  confidence decimal(5,4) NOT NULL DEFAULT 0,
  suggested_action varchar(32) NOT NULL,
  matched_ticket_id varchar(64) NULL,
  reason text NOT NULL,
  created_at datetime(3) NOT NULL,
  KEY idx_message_analysis_message (inbound_message_id),
  KEY idx_message_analysis_action (suggested_action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wechat_order_logs (
  id varchar(128) NOT NULL PRIMARY KEY,
  inbound_message_id varchar(64) NULL,
  channel varchar(16) NOT NULL,
  action varchar(32) NOT NULL,
  ticket_id varchar(64) NULL,
  session_id varchar(64) NULL,
  summary text NOT NULL,
  status varchar(32) NOT NULL,
  created_at datetime(3) NOT NULL,
  KEY idx_wechat_order_logs_created (created_at),
  KEY idx_wechat_order_logs_action (action),
  KEY idx_wechat_order_logs_ticket (ticket_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pending_work_order_sessions (
  id varchar(64) NOT NULL PRIMARY KEY,
  platform varchar(16) NOT NULL,
  conversation_id varchar(64) NOT NULL,
  chat_identity_id varchar(64) NOT NULL,
  original_message_record_id varchar(64) NULL,
  draft_text text NOT NULL,
  draft_images json NOT NULL,
  identity_group varchar(120) NULL,
  contact_name varchar(120) NULL,
  contact_phone varchar(64) NULL,
  person_id varchar(64) NULL,
  booth_number varchar(64) NULL,
  issue_type varchar(120) NULL,
  missing_fields json NOT NULL,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  last_prompt_at datetime(3) NULL,
  KEY idx_pending_session_identity (chat_identity_id),
  KEY idx_pending_session_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS outbound_messages (
  id varchar(64) NOT NULL PRIMARY KEY,
  channel varchar(16) NOT NULL,
  target_conversation_id varchar(160) NULL,
  target_chat_identity_id varchar(64) NULL,
  target_name varchar(160) NOT NULL,
  text text NOT NULL,
  related_ticket_id varchar(64) NULL,
  related_session_id varchar(64) NULL,
  status varchar(32) NOT NULL,
  retry_count int NOT NULL DEFAULT 0,
  last_error text NULL,
  claimed_at datetime(3) NULL,
  sent_at datetime(3) NULL,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  KEY idx_outbound_claim (status, retry_count, claimed_at, created_at),
  KEY idx_outbound_ticket (related_ticket_id),
  KEY idx_outbound_session (related_session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS issue_types (
  id varchar(64) NOT NULL PRIMARY KEY,
  name varchar(120) NOT NULL,
  urgency_minutes int NOT NULL,
  priority_weight int NOT NULL,
  assignment_group varchar(120) NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_issue_types_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assignment_rules (
  id varchar(64) NOT NULL PRIMARY KEY,
  booth_pattern varchar(64) NOT NULL,
  issue_type varchar(120) NOT NULL,
  handler_id varchar(64) NOT NULL,
  handler_name varchar(120) NOT NULL,
  group_name varchar(120) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  KEY idx_assignment_rules_match (booth_pattern, issue_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_status_rules (
  id varchar(64) NOT NULL PRIMARY KEY,
  from_status varchar(32) NOT NULL,
  to_status varchar(32) NOT NULL,
  role varchar(32) NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sla_rules (
  id varchar(64) NOT NULL PRIMARY KEY,
  issue_type varchar(120) NOT NULL,
  response_minutes int NOT NULL,
  resolve_minutes int NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS receipt_rules (
  id varchar(64) NOT NULL PRIMARY KEY,
  event_name varchar(64) NOT NULL,
  template text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_integrations (
  id varchar(64) NOT NULL PRIMARY KEY,
  channel varchar(16) NOT NULL,
  label varchar(120) NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  mcp_server_name varchar(120) NOT NULL,
  endpoint varchar(255) NULL,
  secret_env varchar(120) NULL,
  auto_create_tickets boolean NOT NULL DEFAULT false,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_message_integrations_channel (channel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_model_configs (
  id varchar(32) NOT NULL PRIMARY KEY,
  label varchar(120) NOT NULL,
  provider varchar(32) NOT NULL,
  endpoint varchar(255) NULL,
  api_key_env varchar(120) NULL,
  model_name varchar(120) NOT NULL,
  timeout_ms int NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS keyword_groups (
  id varchar(64) NOT NULL PRIMARY KEY,
  name varchar(120) NOT NULL,
  description varchar(255) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_keyword_groups_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS keyword_rules (
  id varchar(64) NOT NULL PRIMARY KEY,
  group_id varchar(64) NOT NULL,
  keyword varchar(120) NOT NULL,
  match_type varchar(32) NOT NULL,
  action varchar(32) NOT NULL,
  issue_type varchar(120) NULL,
  priority int NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  KEY idx_keyword_rules_group (group_id),
  KEY idx_keyword_rules_keyword (keyword),
  KEY idx_keyword_rules_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_config_versions (
  id varchar(64) NOT NULL PRIMARY KEY,
  version varchar(64) NOT NULL,
  config_json json NOT NULL,
  operator_id varchar(64) NULL,
  operator_name varchar(120) NULL,
  change_summary varchar(255) NOT NULL,
  created_at datetime(3) NOT NULL,
  KEY idx_app_config_versions_created (created_at),
  UNIQUE KEY uniq_app_config_version (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id varchar(64) NOT NULL PRIMARY KEY,
  actor_id varchar(64) NULL,
  actor_name varchar(120) NOT NULL,
  action varchar(80) NOT NULL,
  target_type varchar(80) NOT NULL,
  target_id varchar(120) NULL,
  detail_json json NULL,
  created_at datetime(3) NOT NULL,
  KEY idx_audit_logs_created (created_at),
  KEY idx_audit_logs_action (action),
  KEY idx_audit_logs_target (target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS import_jobs (
  id varchar(64) NOT NULL PRIMARY KEY,
  type varchar(64) NOT NULL,
  source_name varchar(255) NOT NULL,
  status varchar(32) NOT NULL,
  total_rows int NOT NULL DEFAULT 0,
  success_rows int NOT NULL DEFAULT 0,
  failed_rows int NOT NULL DEFAULT 0,
  created_at datetime(3) NOT NULL,
  completed_at datetime(3) NULL,
  KEY idx_import_jobs_created (created_at),
  KEY idx_import_jobs_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS import_job_rows (
  id varchar(64) NOT NULL PRIMARY KEY,
  job_id varchar(64) NOT NULL,
  `row_number` int NOT NULL,
  status varchar(32) NOT NULL,
  message varchar(255) NULL,
  raw_payload json NULL,
  created_at datetime(3) NOT NULL,
  KEY idx_import_job_rows_job (job_id),
  KEY idx_import_job_rows_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
