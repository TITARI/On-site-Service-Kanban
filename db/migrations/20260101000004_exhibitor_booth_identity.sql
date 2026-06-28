-- migrate:up transaction:false
ALTER TABLE exhibition_booths
  DROP KEY IF EXISTS uniq_booth_per_exhibition,
  ADD UNIQUE KEY IF NOT EXISTS uniq_booth_exhibitor_per_exhibition (exhibition_id, booth_number, company_name);
-- migrate:down transaction:false
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'Historical migration cannot be rolled back automatically';
