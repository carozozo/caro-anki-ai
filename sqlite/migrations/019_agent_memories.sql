CREATE TABLE agent_memories (
  id TEXT PRIMARY KEY,
  anki_profile_id TEXT NOT NULL REFERENCES anki_profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX agent_memories_profile_updated_idx
  ON agent_memories (anki_profile_id, updated_at, id);
