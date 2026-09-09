-- The simplified SQLite collection introduced by 009 is replaced by the Anki
-- collection file owned by the bundled Anki runtime, which is the only store
-- that can take part in AnkiWeb sync. Its tables are dropped here; note ids,
-- scheduling, note types, and media now live in collection.anki2.
DROP TABLE IF EXISTS collection_cards;
DROP TABLE IF EXISTS collection_notes;
DROP TABLE IF EXISTS collection_state;
DROP TABLE IF EXISTS collection_decks;
DROP TABLE IF EXISTS collection_models;
