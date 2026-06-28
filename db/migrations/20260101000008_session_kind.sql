-- migrate:up transaction:false
ALTER TABLE pending_work_order_sessions ADD COLUMN session_kind VARCHAR(20) NULL;

UPDATE pending_work_order_sessions
SET session_kind = 'handler-reply'
WHERE issue_type = '__handler-reply';

UPDATE pending_work_order_sessions
SET session_kind = 'work-order'
WHERE issue_type <> '__handler-reply' OR issue_type IS NULL;
-- migrate:down transaction:false
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'Historical migration cannot be rolled back automatically';
