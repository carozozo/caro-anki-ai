-- The legacy singleton row is the factory setting a first launch copies into the first collection profile,
-- so it is where a fresh install's note type actually comes from. It shipped with an English note type
-- baked in; the app now creates a neutral one (`DEFAULT_NOTE_TYPE` in `backend/anki_bridge.py`) and stores
-- 'Caro' as its own default, so the seed moves with it.
--
-- A row the user has touched is a choice and stands, and the two are told apart by the stamp alone: the app
-- writes `updated_at` as ISO-8601 (`now()` in `sqlite/repository.js`), while this row was seeded with
-- SQLite's own `CURRENT_TIMESTAMP` (`YYYY-MM-DD HH:MM:SS`). A stamp still in that shape was never rewritten.
-- The card defaults are checked too, so a row from before that stamp convention — one an older write path
-- could have touched without changing the format — is still recognisably configured and left alone.
UPDATE anki_settings
SET model_name = 'Caro'
WHERE id = 1 AND model_name = 'English' AND updated_at NOT LIKE '%T%'
  AND allow_duplicate = 1 AND visible_decks_json = '[]';
