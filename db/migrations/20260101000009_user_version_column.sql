-- migrate:up transaction:false
ALTER TABLE people
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0;
-- migrate:down transaction:false
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'Historical migration cannot be rolled back automatically';
