CREATE TABLE anki_profile_settings (
  profile_id TEXT PRIMARY KEY REFERENCES anki_profiles(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL,
  allow_duplicate INTEGER NOT NULL CHECK (allow_duplicate IN (0, 1)),
  visible_decks_json TEXT NOT NULL DEFAULT '[]',
  sync_username TEXT NOT NULL DEFAULT '',
  sync_endpoint TEXT,
  sync_media INTEGER NOT NULL DEFAULT 1 CHECK (sync_media IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE anki_profile_creations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  collection_path TEXT NOT NULL UNIQUE,
  staging_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

ALTER TABLE sessions ADD COLUMN anki_profile_id TEXT REFERENCES anki_profiles(id);

CREATE INDEX sessions_anki_profile_updated_idx ON sessions (anki_profile_id, updated_at DESC);
