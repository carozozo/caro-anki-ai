ALTER TABLE anki_exports ADD COLUMN notes_json TEXT NOT NULL DEFAULT '[]';

CREATE UNIQUE INDEX anki_exports_version_attempt_idx ON anki_exports (card_version_id)
  WHERE status IN ('pending', 'completed', 'failed');
