ALTER TABLE people
  ADD COLUMN IF NOT EXISTS group_locked boolean NOT NULL DEFAULT false AFTER group_name_snapshot;

UPDATE people p
JOIN user_groups g ON p.group_id IS NULL AND p.group_name_snapshot = g.name
SET p.group_id = g.id;

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

CREATE TABLE IF NOT EXISTS accounts (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_credentials (
  account_id varchar(128) NOT NULL PRIMARY KEY,
  password_hash varchar(255) NOT NULL,
  password_changed_at datetime(3) NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until datetime(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS roles (
  id varchar(128) NOT NULL PRIMARY KEY,
  name varchar(120) NOT NULL,
  source_group_id varchar(64) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_roles_source_group (source_group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS permissions (
  code varchar(64) NOT NULL PRIMARY KEY,
  name varchar(120) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_roles (
  account_id varchar(128) NOT NULL,
  role_id varchar(128) NOT NULL,
  created_at datetime(3) NOT NULL,
  PRIMARY KEY (account_id, role_id),
  UNIQUE KEY uniq_account_single_role (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id varchar(128) NOT NULL,
  permission_code varchar(64) NOT NULL,
  created_at datetime(3) NOT NULL,
  PRIMARY KEY (role_id, permission_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_sessions (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_bootstrap_state (
  id varchar(32) NOT NULL PRIMARY KEY,
  completed_at datetime(3) NULL,
  completed_by_account_id varchar(128) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions (code, name) VALUES
  ('ticket.claim', '认领工单'),
  ('ticket.process', '处理工单'),
  ('ticket.accept', '验收工单'),
  ('admin.access', '后台管理');

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

INSERT IGNORE INTO role_permissions (role_id, permission_code, created_at)
SELECT CONCAT('role-', id), 'ticket.claim', updated_at
FROM user_groups
WHERE can_claim = true
UNION ALL
SELECT CONCAT('role-', id), 'ticket.process', updated_at
FROM user_groups
WHERE can_process = true
UNION ALL
SELECT CONCAT('role-', id), 'ticket.accept', updated_at
FROM user_groups
WHERE can_accept = true
UNION ALL
SELECT CONCAT('role-', id), 'admin.access', updated_at
FROM user_groups
WHERE can_admin = true;

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

INSERT IGNORE INTO account_roles (account_id, role_id, created_at)
SELECT
  CONCAT('account-', p.id),
  CONCAT('role-', p.group_id),
  p.updated_at
FROM people p
WHERE p.group_id IS NOT NULL;

INSERT IGNORE INTO auth_bootstrap_state (
  id,
  completed_at,
  completed_by_account_id
) VALUES (
  'admin',
  NULL,
  NULL
);

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

ALTER TABLE chat_identities
  ADD UNIQUE KEY IF NOT EXISTS uniq_chat_identity_person_platform (person_id, platform);

ALTER TABLE import_jobs
  ADD COLUMN IF NOT EXISTS owner_account_id varchar(128) NULL,
  ADD COLUMN IF NOT EXISTS source_hash char(64) NULL,
  ADD COLUMN IF NOT EXISTS preview_version varchar(64) NULL,
  ADD COLUMN IF NOT EXISTS updated_at datetime(3) NULL;

ALTER TABLE import_job_rows
  ADD COLUMN IF NOT EXISTS normalized_payload json NULL,
  ADD COLUMN IF NOT EXISTS conflict_json json NULL,
  ADD COLUMN IF NOT EXISTS decision_json json NULL,
  ADD COLUMN IF NOT EXISTS result_action varchar(32) NULL,
  ADD COLUMN IF NOT EXISTS updated_at datetime(3) NULL;
