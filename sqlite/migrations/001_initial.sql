CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  current_card_version_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  cards_json TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ai', 'manual', 'import')),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('unknown', 'valid', 'invalid')),
  validation_errors_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (session_id, version_number)
);

CREATE TABLE IF NOT EXISTS anki_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  card_version_id INTEGER NOT NULL REFERENCES card_versions(id),
  status TEXT NOT NULL CHECK (status IN ('preview', 'pending', 'completed', 'failed')),
  note_ids_json TEXT NOT NULL DEFAULT '[]',
  error_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_session_created_idx
  ON messages (session_id, created_at);

CREATE INDEX IF NOT EXISTS card_versions_session_created_idx
  ON card_versions (session_id, created_at);

CREATE INDEX IF NOT EXISTS anki_exports_session_created_idx
  ON anki_exports (session_id, created_at);
