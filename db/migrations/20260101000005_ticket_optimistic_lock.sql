-- migrate:up transaction:false
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0;

ALTER TABLE ticket_timeline
  ADD COLUMN IF NOT EXISTS to_status VARCHAR(20) NULL;

ALTER TABLE ai_decisions
  ADD COLUMN IF NOT EXISTS provider VARCHAR(8) NOT NULL DEFAULT 'mock';
-- migrate:down transaction:false
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'Historical migration cannot be rolled back automatically';
