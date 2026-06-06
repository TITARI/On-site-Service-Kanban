CREATE TABLE IF NOT EXISTS wxauto_integration_locks (
  name varchar(64) NOT NULL PRIMARY KEY,
  updated_at datetime(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO wxauto_integration_locks (name, updated_at)
VALUES ('state-write', CURRENT_TIMESTAMP(3));
