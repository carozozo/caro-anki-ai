CREATE TABLE anki_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  deck_name TEXT NOT NULL,
  model_name TEXT NOT NULL,
  allow_duplicate INTEGER NOT NULL CHECK (allow_duplicate IN (0, 1)),
  sync_username TEXT NOT NULL,
  sync_endpoint TEXT,
  sync_media INTEGER NOT NULL CHECK (sync_media IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT INTO anki_settings
  (id, deck_name, model_name, allow_duplicate, sync_username, sync_endpoint, sync_media, updated_at)
VALUES (1, '_Todo', 'English', 1, '', NULL, 0, CURRENT_TIMESTAMP);
