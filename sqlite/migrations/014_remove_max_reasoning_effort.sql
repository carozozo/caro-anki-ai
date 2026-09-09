-- `max` is no longer offered: it buys a 128K thinking budget for work that is mostly vocabulary lookups and
-- card writing, and in practice that deliberation consumed the whole reply budget and returned nothing.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt around its rows; an existing `max` profile
-- keeps the closest lower level instead of failing the migration.
CREATE TABLE agent_profiles_next (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('deepseek')),
  model TEXT NOT NULL,
  base_url TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('auto', 'none', 'low', 'high')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO agent_profiles_next (id, name, provider, model, base_url, reasoning_effort, created_at, updated_at)
SELECT id, name, provider, model, base_url,
  CASE WHEN reasoning_effort = 'max' THEN 'high' ELSE reasoning_effort END,
  created_at, updated_at
FROM agent_profiles;

DROP TABLE agent_profiles;
ALTER TABLE agent_profiles_next RENAME TO agent_profiles;
