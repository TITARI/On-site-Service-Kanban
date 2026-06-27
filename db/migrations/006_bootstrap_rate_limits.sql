CREATE TABLE IF NOT EXISTS bootstrap_rate_limits (
  ip_key varchar(255) NOT NULL,
  attempts int unsigned NOT NULL,
  reset_at datetime(3) NOT NULL,
  PRIMARY KEY (ip_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
