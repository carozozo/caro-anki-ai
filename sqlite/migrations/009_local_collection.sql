CREATE TABLE collection_models (
  name TEXT PRIMARY KEY,
  field_names_json TEXT NOT NULL,
  sort_field_index INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE collection_decks (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE collection_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_deck_name TEXT NOT NULL REFERENCES collection_decks(name)
);

CREATE TABLE collection_notes (
  id INTEGER PRIMARY KEY,
  model_name TEXT NOT NULL REFERENCES collection_models(name),
  fields_json TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE collection_cards (
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES collection_notes(id) ON DELETE CASCADE,
  deck_name TEXT NOT NULL REFERENCES collection_decks(name),
  due_at TEXT,
  flag INTEGER NOT NULL DEFAULT 0 CHECK (flag BETWEEN 0 AND 7),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX collection_cards_note_idx ON collection_cards(note_id);
CREATE INDEX collection_cards_deck_idx ON collection_cards(deck_name);
CREATE INDEX collection_notes_created_idx ON collection_notes(created_at);

INSERT INTO collection_models (name, field_names_json, sort_field_index) VALUES
  ('English', '["意思","含意","字意","註解","詞彙","詞彙US","詞彙UK","同義詞","反義詞","聯想詞","類型","類型標籤","音標","不規則","範例"]', 4),
  ('Basic', '["Front","Back"]', 0);

INSERT INTO collection_decks (name, created_at) VALUES
  ('Default', CURRENT_TIMESTAMP),
  ('_Todo', CURRENT_TIMESTAMP);

INSERT INTO collection_state (id, current_deck_name) VALUES (1, '_Todo');
