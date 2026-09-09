-- The browser hid decks by name in the frontend (a leading `-` and `Default`), which is the user's call
-- rather than the code's. `visible_decks_json` is that user's whitelist as a JSON array of deck names;
-- an empty array means every deck in the collection, so removing the hardcoded filter changes nothing
-- until the user picks decks in Settings.
ALTER TABLE anki_settings ADD COLUMN visible_decks_json TEXT NOT NULL DEFAULT '[]';
