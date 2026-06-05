CREATE TABLE IF NOT EXISTS wxauto_agents (
  id varchar(128) NOT NULL PRIMARY KEY,
  display_name varchar(160) NOT NULL,
  app_version varchar(64) NOT NULL,
  worker_version varchar(64) NOT NULL,
  windows_version varchar(120) NOT NULL,
  wechat_process_state varchar(32) NOT NULL,
  wechat_login_state varchar(32) NOT NULL,
  safety_mode varchar(32) NOT NULL,
  capabilities_json json NOT NULL,
  last_seen_at datetime(3) NOT NULL,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  KEY idx_wxauto_agents_seen (last_seen_at),
  KEY idx_wxauto_agents_login (wechat_login_state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wxauto_event_receipts (
  id varchar(128) NOT NULL PRIMARY KEY,
  agent_id varchar(128) NOT NULL,
  message_id varchar(160) NOT NULL,
  inbound_message_id varchar(64) NULL,
  action varchar(32) NOT NULL,
  result_json json NOT NULL,
  created_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_wxauto_event (agent_id, message_id),
  KEY idx_wxauto_receipts_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE outbound_messages
  ADD COLUMN claimed_by_agent_id varchar(128) NULL AFTER claimed_at,
  ADD COLUMN lease_id varchar(64) NULL AFTER claimed_by_agent_id,
  ADD COLUMN lease_expires_at datetime(3) NULL AFTER lease_id,
  ADD COLUMN safety_rule varchar(120) NULL AFTER last_error,
  ADD UNIQUE KEY uniq_outbound_lease (lease_id),
  ADD KEY idx_outbound_agent_lease (claimed_by_agent_id, lease_expires_at);

CREATE TABLE IF NOT EXISTS outbound_message_attempts (
  id varchar(64) NOT NULL PRIMARY KEY,
  message_id varchar(64) NOT NULL,
  agent_id varchar(128) NOT NULL,
  lease_id varchar(64) NOT NULL,
  status varchar(40) NOT NULL,
  error_text text NULL,
  safety_rule varchar(120) NULL,
  attempted_at datetime(3) NOT NULL,
  completed_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_outbound_attempt_lease (lease_id),
  KEY idx_outbound_attempt_message (message_id, completed_at),
  KEY idx_outbound_attempt_agent (agent_id, completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wxauto_releases (
  version varchar(64) NOT NULL PRIMARY KEY,
  channel varchar(32) NOT NULL,
  file_name varchar(255) NOT NULL,
  file_path varchar(512) NOT NULL,
  file_size bigint NOT NULL,
  sha256 char(64) NOT NULL,
  release_notes text NOT NULL,
  manifest_json json NOT NULL,
  signature text NOT NULL,
  published_at datetime(3) NOT NULL,
  created_at datetime(3) NOT NULL,
  KEY idx_wxauto_releases_channel (channel, published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
