DROP INDEX IF EXISTS anki_exports_version_attempt_idx;

ALTER TABLE anki_exports ADD COLUMN card_index INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX anki_exports_version_card_attempt_idx ON anki_exports (card_version_id, card_index)
  WHERE status IN ('pending', 'completed', 'failed');
