ALTER TABLE pending_work_order_sessions ADD COLUMN session_kind VARCHAR(20) NULL;

UPDATE pending_work_order_sessions
SET session_kind = 'handler-reply'
WHERE issue_type = '__handler-reply';

UPDATE pending_work_order_sessions
SET session_kind = 'work-order'
WHERE issue_type <> '__handler-reply' OR issue_type IS NULL;
