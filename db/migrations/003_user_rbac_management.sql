ALTER TABLE people
  ADD COLUMN group_locked boolean NOT NULL DEFAULT false AFTER group_name_snapshot;

UPDATE people p
JOIN user_groups ug
  ON ug.name = p.group_name_snapshot
  AND ug.enabled = true
SET p.group_id = ug.id
WHERE p.group_id IS NULL
  OR p.group_id = ''
  OR NOT EXISTS (
    SELECT 1
    FROM user_groups assigned_group
    WHERE assigned_group.id = p.group_id
      AND assigned_group.enabled = true
  );

UPDATE people p
LEFT JOIN user_groups assigned_group
  ON assigned_group.id = p.group_id
  AND assigned_group.enabled = true
SET p.group_id = (
  SELECT fallback_group.id
  FROM user_groups fallback_group
  WHERE fallback_group.enabled = true
  ORDER BY fallback_group.id
  LIMIT 1
)
WHERE assigned_group.id IS NULL;

CREATE TABLE IF NOT EXISTS accounts (
  id varchar(128) NOT NULL PRIMARY KEY,
  person_id varchar(64) NOT NULL,
  login_name varchar(160) NOT NULL,
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
  password_changed_at datetime(3) NULL,
  must_change_password boolean NOT NULL DEFAULT true,
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
  PRIMARY KEY pk_account_roles (account_id, role_id),
  UNIQUE KEY uniq_account_roles_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id varchar(128) NOT NULL,
  permission_code varchar(64) NOT NULL,
  created_at datetime(3) NOT NULL,
  PRIMARY KEY pk_role_permissions (role_id, permission_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_sessions (
  id varchar(128) NOT NULL PRIMARY KEY,
  account_id varchar(128) NOT NULL,
  session_type varchar(32) NOT NULL,
  token_hash varchar(255) NOT NULL,
  auth_version int NOT NULL,
  expires_at datetime(3) NOT NULL,
  last_seen_at datetime(3) NOT NULL,
  revoked_at datetime(3) NULL,
  created_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_account_sessions_token_hash (token_hash),
  KEY idx_account_sessions_lookup (session_type, token_hash, revoked_at, expires_at),
  KEY idx_account_sessions_account (account_id, revoked_at, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_bootstrap_state (
  id varchar(64) NOT NULL PRIMARY KEY,
  completed_at datetime(3) NULL,
  completed_by_account_id varchar(128) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions (code, name) VALUES
  ('ticket.claim', '工单认领'),
  ('ticket.process', '工单处理'),
  ('ticket.accept', '工单验收'),
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
SELECT CONCAT('role-', id), 'ticket.claim', CURRENT_TIMESTAMP(3)
FROM user_groups
WHERE can_claim = true
UNION ALL
SELECT CONCAT('role-', id), 'ticket.process', CURRENT_TIMESTAMP(3)
FROM user_groups
WHERE can_process = true
UNION ALL
SELECT CONCAT('role-', id), 'ticket.accept', CURRENT_TIMESTAMP(3)
FROM user_groups
WHERE can_accept = true
UNION ALL
SELECT CONCAT('role-', id), 'admin.access', CURRENT_TIMESTAMP(3)
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
  CURRENT_TIMESTAMP(3)
FROM people p
JOIN user_groups ug ON ug.id = p.group_id;

INSERT IGNORE INTO auth_bootstrap_state (
  id,
  completed_at,
  completed_by_account_id
) VALUES (
  'admin',
  NULL,
  NULL
);

DELETE duplicate_identity
FROM chat_identities duplicate_identity
JOIN chat_identities keeper_identity
  ON keeper_identity.person_id = duplicate_identity.person_id
  AND keeper_identity.platform = duplicate_identity.platform
  AND (
    keeper_identity.last_seen_at > duplicate_identity.last_seen_at
    OR (
      keeper_identity.last_seen_at = duplicate_identity.last_seen_at
      AND keeper_identity.id < duplicate_identity.id
    )
  )
WHERE duplicate_identity.person_id IS NOT NULL;

ALTER TABLE chat_identities
  ADD UNIQUE KEY uniq_chat_identity_person_platform (person_id, platform);

ALTER TABLE import_jobs
  ADD COLUMN owner_account_id varchar(128) NULL AFTER id,
  ADD COLUMN source_hash varchar(128) NULL AFTER source_name,
  ADD COLUMN preview_version int NOT NULL DEFAULT 1 AFTER source_hash,
  ADD COLUMN updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER created_at;

ALTER TABLE import_job_rows
  ADD COLUMN normalized_payload json NULL AFTER raw_payload,
  ADD COLUMN conflict_json json NULL AFTER normalized_payload,
  ADD COLUMN decision_json json NULL AFTER conflict_json,
  ADD COLUMN result_action varchar(32) NULL AFTER decision_json,
  ADD COLUMN updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER created_at;
