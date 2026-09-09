CREATE TABLE anki_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  collection_path TEXT NOT NULL UNIQUE,
  pending_name TEXT,
  pending_collection_path TEXT,
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'migrating')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE anki_profile_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_profile_id TEXT REFERENCES anki_profiles(id)
);

INSERT INTO anki_profile_state (id, active_profile_id) VALUES (1, NULL);
