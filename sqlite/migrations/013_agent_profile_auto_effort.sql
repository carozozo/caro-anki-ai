-- `auto` leaves the reasoning effort to the backend, which classifies each request instead of making the
-- user pick a budget. SQLite cannot alter a CHECK constraint, so the table is rebuilt around its rows.
CREATE TABLE agent_profiles_next (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('deepseek')),
  model TEXT NOT NULL,
  base_url TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('auto', 'none', 'low', 'high', 'max')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO agent_profiles_next (id, name, provider, model, base_url, reasoning_effort, created_at, updated_at)
SELECT id, name, provider, model, base_url, reasoning_effort, created_at, updated_at FROM agent_profiles;

DROP TABLE agent_profiles;
ALTER TABLE agent_profiles_next RENAME TO agent_profiles;
