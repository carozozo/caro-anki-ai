CREATE TABLE agent_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  active_profile_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('deepseek')),
  model TEXT NOT NULL,
  base_url TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('none', 'low', 'high', 'max')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO agent_settings (id, enabled, active_profile_id, updated_at)
VALUES (1, 0, NULL, CURRENT_TIMESTAMP);
