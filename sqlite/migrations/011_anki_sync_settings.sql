ALTER TABLE anki_settings ADD COLUMN sync_username TEXT NOT NULL DEFAULT '';
ALTER TABLE anki_settings ADD COLUMN sync_endpoint TEXT;
ALTER TABLE anki_settings ADD COLUMN sync_media INTEGER NOT NULL DEFAULT 1 CHECK (sync_media IN (0, 1));
