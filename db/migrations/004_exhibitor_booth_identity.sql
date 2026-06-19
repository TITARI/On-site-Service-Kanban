ALTER TABLE exhibition_booths
  DROP KEY IF EXISTS uniq_booth_per_exhibition,
  ADD UNIQUE KEY IF NOT EXISTS uniq_booth_exhibitor_per_exhibition (exhibition_id, booth_number, company_name);
