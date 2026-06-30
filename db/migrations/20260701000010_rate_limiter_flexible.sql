-- migrate:up transaction:false
-- Bootstrap counters are short-lived security state. Recreate the table once
-- using rate-limiter-flexible's required schema instead of carrying old rows.
DROP TABLE IF EXISTS bootstrap_rate_limits;

CREATE TABLE bootstrap_rate_limits (
  `key` VARCHAR(255) CHARACTER SET utf8 NOT NULL,
  `points` INT(9) NOT NULL DEFAULT 0,
  `expire` BIGINT UNSIGNED,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB;

-- migrate:down transaction:false
DROP TABLE IF EXISTS bootstrap_rate_limits;

CREATE TABLE bootstrap_rate_limits (
  ip_key varchar(255) NOT NULL,
  attempts int unsigned NOT NULL,
  reset_at datetime(3) NOT NULL,
  PRIMARY KEY (ip_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
