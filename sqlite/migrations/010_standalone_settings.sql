CREATE TABLE anki_settings_next (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model_name TEXT NOT NULL,
  allow_duplicate INTEGER NOT NULL CHECK (allow_duplicate IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT INTO anki_settings_next (id, model_name, allow_duplicate, updated_at)
SELECT id, model_name, allow_duplicate, updated_at FROM anki_settings;

DROP TABLE anki_settings;
ALTER TABLE anki_settings_next RENAME TO anki_settings;
