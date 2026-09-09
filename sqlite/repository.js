const { randomUUID } = require('node:crypto');
const { DEFAULT_AGENT_LANGUAGE } = require('../backend/agent-language');

function now () {
  return new Date().toISOString();
}

function stableJson (value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const ankiProfileColumns = `id, name, collection_path AS collectionPath, pending_name AS pendingName,
  pending_collection_path AS pendingCollectionPath, state, created_at AS createdAt, updated_at AS updatedAt`;
const ankiProfileCreationColumns = `id, name, collection_path AS collectionPath,
  staging_path AS stagingPath, created_at AS createdAt`;
// A new profile's own starting point, kept in step with the note type a fresh collection is created with
// (`DEFAULT_NOTE_TYPE` in `backend/anki_bridge.py`). An existing profile keeps the choice stored in its row.
const defaultAnkiProfileSettings = {
  modelName: 'Caro', allowDuplicate: true, visibleDecks: [], username: '', endpoint: null, media: true,
};

const deserializeAnkiSettings = row => ({
  modelName: row.model_name,
  allowDuplicate: Boolean(row.allow_duplicate),
  visibleDecks: JSON.parse(row.visible_decks_json),
});

const deserializeAnkiSyncSettings = row => ({
  username: row.sync_username,
  endpoint: row.sync_endpoint,
  media: Boolean(row.sync_media),
});

class Repository {
  constructor (db) {
    this.db = db;
  }

  getLegacyAnkiSettings () {
    const row = this.db.prepare(
      'SELECT model_name, allow_duplicate, visible_decks_json FROM anki_settings WHERE id = 1').get();
    return deserializeAnkiSettings(row);
  }

  getAnkiSettings (profileId = null) {
    if (!profileId) return this.getLegacyAnkiSettings();
    const row = this.db.prepare(`SELECT model_name, allow_duplicate, visible_decks_json
      FROM anki_profile_settings WHERE profile_id = ?`).get(profileId);
    if (!row) throw new Error('Collection profile settings are missing');
    return deserializeAnkiSettings(row);
  }

  updateAnkiSettings ({ modelName, allowDuplicate, visibleDecks }, profileId = null) {
    if (profileId) {
      this.db.prepare(`UPDATE anki_profile_settings SET model_name = ?, allow_duplicate = ?, visible_decks_json = ?,
        updated_at = ? WHERE profile_id = ?`)
        .run(modelName, Number(allowDuplicate), JSON.stringify(visibleDecks), now(), profileId);
      return this.getAnkiSettings(profileId);
    }
    this.db.prepare(`UPDATE anki_settings SET model_name = ?, allow_duplicate = ?, visible_decks_json = ?,
      updated_at = ? WHERE id = 1`)
      .run(modelName, Number(allowDuplicate), JSON.stringify(visibleDecks), now());
    return this.getAnkiSettings();
  }

  getLegacyAnkiSyncSettings () {
    const row = this.db.prepare(`SELECT sync_username, sync_endpoint, sync_media
      FROM anki_settings WHERE id = 1`).get();
    return deserializeAnkiSyncSettings(row);
  }

  getAnkiSyncSettings (profileId = null) {
    if (!profileId) return this.getLegacyAnkiSyncSettings();
    const row = this.db.prepare(`SELECT sync_username, sync_endpoint, sync_media
      FROM anki_profile_settings WHERE profile_id = ?`).get(profileId);
    if (!row) throw new Error('Collection profile settings are missing');
    return deserializeAnkiSyncSettings(row);
  }

  updateAnkiSyncSettings ({ username, endpoint, media }, profileId = null) {
    if (profileId) {
      this.db.prepare(`UPDATE anki_profile_settings SET sync_username = ?, sync_endpoint = ?, sync_media = ?,
        updated_at = ? WHERE profile_id = ?`).run(username, endpoint, Number(media), now(), profileId);
      return this.getAnkiSyncSettings(profileId);
    }
    this.db.prepare(`UPDATE anki_settings SET sync_username = ?, sync_endpoint = ?, sync_media = ?, updated_at = ?
      WHERE id = 1`).run(username, endpoint, Number(media), now());
    return this.getAnkiSyncSettings();
  }

  ensureAnkiProfileSettings (profileId, { copyLegacy = false } = {}) {
    const existing = this.db.prepare('SELECT profile_id FROM anki_profile_settings WHERE profile_id = ?').get(profileId);
    if (existing) return this.getAnkiSettings(profileId);
    const source = copyLegacy ? { ...this.getLegacyAnkiSettings(), ...this.getLegacyAnkiSyncSettings() }
      : defaultAnkiProfileSettings;
    const timestamp = now();
    this.db.prepare(`INSERT INTO anki_profile_settings
      (profile_id, model_name, allow_duplicate, visible_decks_json, sync_username, sync_endpoint, sync_media,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(profileId, source.modelName, Number(source.allowDuplicate), JSON.stringify(source.visibleDecks),
        source.username, source.endpoint, Number(source.media), timestamp, timestamp);
    return this.getAnkiSettings(profileId);
  }

  listAnkiProfiles () {
    return this.db.prepare(`SELECT ${ankiProfileColumns} FROM anki_profiles ORDER BY created_at`).all();
  }

  getAnkiProfile (id) {
    return this.db.prepare(`SELECT ${ankiProfileColumns} FROM anki_profiles WHERE id = ?`).get(id) || null;
  }

  getActiveAnkiProfile () {
    return this.db.prepare(`SELECT profile.id, profile.name, profile.collection_path AS collectionPath,
      profile.pending_name AS pendingName, profile.pending_collection_path AS pendingCollectionPath,
      profile.state, profile.created_at AS createdAt, profile.updated_at AS updatedAt
      FROM anki_profile_state AS state JOIN anki_profiles AS profile ON profile.id = state.active_profile_id
      WHERE state.id = 1`).get() || null;
  }

  setActiveAnkiProfile (id) {
    const profile = this.getAnkiProfile(id);
    if (!profile) throw new Error('Collection profile not found');
    this.db.prepare('UPDATE anki_profile_state SET active_profile_id = ? WHERE id = 1').run(id);
    return profile;
  }

  ensureAnkiProfile ({ name, collectionPath }) {
    const active = this.getActiveAnkiProfile();
    if (active) return { profile: active, created: false };
    const known = this.db.prepare(`SELECT ${ankiProfileColumns} FROM anki_profiles
      WHERE collection_path = ?`).get(collectionPath);
    if (known) {
      this.db.prepare('UPDATE anki_profile_state SET active_profile_id = ? WHERE id = 1').run(known.id);
      return { profile: known, created: false };
    }
    const id = randomUUID();
    const timestamp = now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO anki_profiles
        (id, name, collection_path, state, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, ?)`)
        .run(id, name, collectionPath, timestamp, timestamp);
      this.db.prepare('UPDATE anki_profile_state SET active_profile_id = ? WHERE id = 1').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { profile: this.getAnkiProfile(id), created: true };
  }

  renameAnkiProfile (id, name) {
    this.db.prepare('UPDATE anki_profiles SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id);
    return this.getAnkiProfile(id);
  }

  beginAnkiProfileMigration (id, { name, collectionPath }) {
    const result = this.db.prepare(`UPDATE anki_profiles SET pending_name = ?, pending_collection_path = ?,
      state = 'migrating', updated_at = ? WHERE id = ? AND state = 'ready'`)
      .run(name, collectionPath, now(), id);
    if (result.changes !== 1) throw new Error('Profile migration is not ready');
    return this.getAnkiProfile(id);
  }

  finishAnkiProfileMigration (id) {
    const result = this.db.prepare(`UPDATE anki_profiles SET name = pending_name,
      collection_path = pending_collection_path, pending_name = NULL, pending_collection_path = NULL,
      state = 'ready', updated_at = ? WHERE id = ? AND state = 'migrating'`)
      .run(now(), id);
    if (result.changes !== 1) throw new Error('Profile migration cannot be completed');
    return this.getAnkiProfile(id);
  }

  cancelAnkiProfileMigration (id) {
    this.db.prepare(`UPDATE anki_profiles SET pending_name = NULL, pending_collection_path = NULL,
      state = 'ready', updated_at = ? WHERE id = ? AND state = 'migrating'`).run(now(), id);
    return this.getAnkiProfile(id);
  }

  listAnkiProfileCreations () {
    return this.db.prepare(`SELECT ${ankiProfileCreationColumns} FROM anki_profile_creations ORDER BY created_at`).all();
  }

  getAnkiProfileCreation (id) {
    return this.db.prepare(`SELECT ${ankiProfileCreationColumns} FROM anki_profile_creations WHERE id = ?`)
      .get(id) || null;
  }

  beginAnkiProfileCreation ({ id, name, collectionPath, stagingPath }) {
    this.db.prepare(`INSERT INTO anki_profile_creations (id, name, collection_path, staging_path, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(id, name, collectionPath, stagingPath, now());
    return this.getAnkiProfileCreation(id);
  }

  finishAnkiProfileCreation (id) {
    const creation = this.getAnkiProfileCreation(id);
    if (!creation) throw new Error('Collection profile creation is missing');
    const timestamp = now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO anki_profiles
        (id, name, collection_path, state, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, ?)`)
        .run(creation.id, creation.name, creation.collectionPath, timestamp, timestamp);
      this.db.prepare(`INSERT INTO anki_profile_settings
        (profile_id, model_name, allow_duplicate, visible_decks_json, sync_username, sync_endpoint, sync_media,
          created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(creation.id, defaultAnkiProfileSettings.modelName, Number(defaultAnkiProfileSettings.allowDuplicate),
          JSON.stringify(defaultAnkiProfileSettings.visibleDecks), defaultAnkiProfileSettings.username,
          defaultAnkiProfileSettings.endpoint, Number(defaultAnkiProfileSettings.media), timestamp, timestamp);
      this.db.prepare('DELETE FROM anki_profile_creations WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getAnkiProfile(id);
  }

  cancelAnkiProfileCreation (id) {
    return this.db.prepare('DELETE FROM anki_profile_creations WHERE id = ?').run(id).changes;
  }

  // A deleted profile takes its chat workspace with it: those conversations describe a collection that no
  // longer exists, and `sessions.anki_profile_id` is a plain reference, so the rows leave first. The profile's
  // settings follow through `anki_profile_settings.profile_id` (ON DELETE CASCADE). The caller has already
  // refused the active profile, so `anki_profile_state.active_profile_id` is never pointing here.
  deleteAnkiProfile (id) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM anki_exports WHERE session_id IN
        (SELECT id FROM sessions WHERE anki_profile_id = ?)`).run(id);
      this.db.prepare('DELETE FROM sessions WHERE anki_profile_id = ?').run(id);
      const { changes } = this.db.prepare('DELETE FROM anki_profiles WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return changes;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  bindLegacySessionsToProfile (profileId) {
    return this.db.prepare('UPDATE sessions SET anki_profile_id = ? WHERE anki_profile_id IS NULL').run(profileId).changes;
  }

  getAgentSettings () {
    const row = this.db.prepare('SELECT enabled, active_profile_id FROM agent_settings WHERE id = 1').get();
    return { enabled: Boolean(row.enabled), activeProfileId: row.active_profile_id };
  }

  updateAgentSettings ({ enabled, activeProfileId }) {
    const current = this.getAgentSettings();
    const next = { enabled: enabled ?? current.enabled, activeProfileId: activeProfileId ?? current.activeProfileId };
    if (next.activeProfileId && !this.getAgentProfile(next.activeProfileId)) throw new Error('Agent profile not found');
    this.db.prepare(`UPDATE agent_settings SET enabled = ?, active_profile_id = ?, updated_at = ? WHERE id = 1`)
      .run(Number(next.enabled), next.activeProfileId, now());
    return this.getAgentSettings();
  }

  listAgentProfiles () {
    return this.db.prepare(`SELECT id, name, provider, model, base_url AS baseUrl,
      reasoning_effort AS reasoningEffort, language, step_limit AS stepLimit, created_at AS createdAt,
      updated_at AS updatedAt
      FROM agent_profiles ORDER BY created_at`).all();
  }

  getAgentProfile (id) {
    return this.listAgentProfiles().find(profile => profile.id === id) || null;
  }

  createAgentProfile ({ name, provider, model, baseUrl, reasoningEffort, language = DEFAULT_AGENT_LANGUAGE,
    stepLimit = 12 }) {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO agent_profiles
      (id, name, provider, model, base_url, reasoning_effort, language, step_limit, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, provider, model, baseUrl, reasoningEffort, language, stepLimit, timestamp, timestamp);
    if (!this.getAgentSettings().activeProfileId) this.updateAgentSettings({ activeProfileId: id });
    return this.getAgentProfile(id);
  }

  updateAgentProfile (id, { name, provider, model, baseUrl, reasoningEffort, language, stepLimit }) {
    this.db.prepare(`UPDATE agent_profiles SET name = ?, provider = ?, model = ?, base_url = ?,
      reasoning_effort = ?, language = ?, step_limit = ?, updated_at = ? WHERE id = ?`)
      .run(name, provider, model, baseUrl, reasoningEffort, language, stepLimit, now(), id);
    return this.getAgentProfile(id);
  }

  deleteAgentProfile (id) {
    const settings = this.getAgentSettings();
    const { changes } = this.db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id);
    if (changes && settings.activeProfileId === id) {
      const next = this.listAgentProfiles()[0]?.id || null;
      this.db.prepare('UPDATE agent_settings SET active_profile_id = ?, updated_at = ? WHERE id = 1').run(next, now());
    }
    return changes;
  }

  listAgentMemories (profileId) {
    return this.db.prepare(`SELECT id, content, created_at AS createdAt, updated_at AS updatedAt
      FROM agent_memories WHERE anki_profile_id = ? ORDER BY updated_at, id`).all(profileId);
  }

  applyAgentMemories (profileId, { additions, updates, removals }) {
    const timestamp = now();
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare(`INSERT INTO agent_memories
        (id, anki_profile_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
      const update = this.db.prepare(`UPDATE agent_memories SET content = ?, updated_at = ?
        WHERE id = ? AND anki_profile_id = ?`);
      const remove = this.db.prepare('DELETE FROM agent_memories WHERE id = ? AND anki_profile_id = ?');
      additions.forEach(({ id, content }) => insert.run(id, profileId, content, timestamp, timestamp));
      updates.forEach(({ id, content }) => update.run(content, timestamp, id, profileId));
      removals.forEach(id => remove.run(id, profileId));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createAnkiPreview ({ sessionId, cardVersionId, cardIndex, notes, profileId = null }) {
    if (profileId && !this.getSession(sessionId, profileId)) throw new Error('Session not found');
    const result = this.db.prepare(`
      INSERT INTO anki_exports (session_id, card_version_id, card_index, status, notes_json, created_at)
      VALUES (?, ?, ?, 'preview', ?, ?)
    `).run(sessionId, cardVersionId, cardIndex, JSON.stringify(notes), now());
    return this.getAnkiExport(sessionId, Number(result.lastInsertRowid), profileId);
  }

  getAnkiExport (sessionId, id, profileId = null) {
    const query = `SELECT * FROM anki_exports WHERE session_id = ? AND id = ?${profileId
      ? ' AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND anki_profile_id = ?)' : ''}`;
    return this.db.prepare(query).get(sessionId, id, ...(profileId ? [sessionId, profileId] : []));
  }

  listAnkiExports (sessionId, profileId = null) {
    const query = `SELECT * FROM anki_exports WHERE session_id = ?${profileId
      ? ' AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND anki_profile_id = ?)' : ''} ORDER BY id DESC`;
    return this.db.prepare(query).all(sessionId, ...(profileId ? [sessionId, profileId] : []));
  }

  claimAnkiExport (sessionId, id, profileId = null) {
    const query = `
      UPDATE anki_exports SET status = 'pending'
      WHERE session_id = ? AND id = ? AND status = 'preview'${profileId
        ? ' AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND anki_profile_id = ?)' : ''}`;
    return this.db.prepare(query).run(sessionId, id, ...(profileId ? [sessionId, profileId] : [])).changes === 1;
  }

  finishAnkiExport (sessionId, id, noteIds, error, profileId = null) {
    const query = `
      UPDATE anki_exports SET status = ?, note_ids_json = ?, error_json = ?
      WHERE session_id = ? AND id = ? AND status = 'pending'${profileId
        ? ' AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND anki_profile_id = ?)' : ''}`;
    this.db.prepare(query).run(error ? 'failed' : 'completed', JSON.stringify(noteIds),
      error ? JSON.stringify(error) : null, sessionId, id, ...(profileId ? [sessionId, profileId] : []));
    return this.getAnkiExport(sessionId, id, profileId);
  }

  clearSessions (profileId = null) {
    this.db.exec('BEGIN');
    try {
      if (profileId) {
        this.db.prepare(`DELETE FROM anki_exports WHERE session_id IN
          (SELECT id FROM sessions WHERE anki_profile_id = ?)`).run(profileId);
      } else this.db.prepare('DELETE FROM anki_exports').run();
      const { changes } = profileId
        ? this.db.prepare('DELETE FROM sessions WHERE anki_profile_id = ?').run(profileId)
        : this.db.prepare('DELETE FROM sessions').run();
      this.db.exec('COMMIT');
      return changes;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // anki_exports holds a non-cascading FK to card_versions, so exports must go first:
  // deleting the session cascades to card_versions and would otherwise violate that FK.
  deleteSession (id, profileId = null) {
    this.db.exec('BEGIN');
    try {
      if (profileId) {
        this.db.prepare(`DELETE FROM anki_exports WHERE session_id = ? AND EXISTS
          (SELECT 1 FROM sessions WHERE id = ? AND anki_profile_id = ?)`).run(id, id, profileId);
      } else this.db.prepare('DELETE FROM anki_exports WHERE session_id = ?').run(id);
      const { changes } = profileId
        ? this.db.prepare('DELETE FROM sessions WHERE id = ? AND anki_profile_id = ?').run(id, profileId)
        : this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return changes;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createSession ({ id = randomUUID(), title = 'Untitled card workspace', profileId = null } = {}) {
    const timestamp = now();
    if (profileId) {
      this.db.prepare(`INSERT INTO sessions (id, title, anki_profile_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`).run(id, title.trim() || 'Untitled card workspace', profileId, timestamp, timestamp);
    } else {
      this.db.prepare(`INSERT INTO sessions (id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?)`).run(id, title.trim() || 'Untitled card workspace', timestamp, timestamp);
    }
    return this.getSession(id, profileId);
  }

  listSessions (profileId = null) {
    const query = `SELECT id, title, current_card_version_id, created_at, updated_at
      FROM sessions${profileId ? ' WHERE anki_profile_id = ?' : ''} ORDER BY updated_at DESC`;
    return this.db.prepare(query).all(...(profileId ? [profileId] : []));
  }

  getSession (id, profileId = null) {
    const query = `SELECT id, title, current_card_version_id, created_at, updated_at
      FROM sessions WHERE id = ?${profileId ? ' AND anki_profile_id = ?' : ''}`;
    return this.db.prepare(query).get(id, ...(profileId ? [profileId] : [])) || null;
  }

  updateSessionTitle (id, title, profileId = null) {
    const value = title.trim();
    if (!value) throw new Error('Session title is required');
    const timestamp = now();
    const { changes } = this.db.prepare(`UPDATE sessions SET title = ?, updated_at = ?
      WHERE id = ?${profileId ? ' AND anki_profile_id = ?' : ''}`)
      .run(value, timestamp, id, ...(profileId ? [profileId] : []));
    return changes ? this.getSession(id, profileId) : null;
  }

  addMessage ({ sessionId, role, content, payload = null, profileId = null }) {
    if (profileId && !this.getSession(sessionId, profileId)) throw new Error('Session not found');
    const timestamp = now();
    const result = this.db.prepare(`
      INSERT INTO messages (session_id, role, content, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, role, content, payload === null ? null : JSON.stringify(payload), timestamp);
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(timestamp, sessionId);
    return this.db.prepare(`
      SELECT id, session_id, role, content, payload_json, created_at
      FROM messages
      WHERE id = ?
    `).get(result.lastInsertRowid);
  }

  listMessages (sessionId, profileId = null) {
    const query = `
      SELECT id, session_id, role, content, payload_json, created_at
      FROM messages
      WHERE session_id = ?${profileId
        ? ' AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND anki_profile_id = ?)' : ''}
      ORDER BY id ASC`;
    return this.db.prepare(query).all(sessionId, ...(profileId ? [sessionId, profileId] : []));
  }

  getCurrentCardVersion (sessionId, profileId = null) {
    const query = `
      SELECT id, session_id, version_number, cards_json, schema_version, source,
        validation_status, validation_errors_json, created_at
      FROM card_versions WHERE id = (SELECT current_card_version_id FROM sessions WHERE id = ?${profileId
        ? ' AND anki_profile_id = ?' : ''})`;
    return this.db.prepare(query).get(sessionId, ...(profileId ? [profileId] : [])) || null;
  }

  getCardVersion (sessionId, id, profileId = null) {
    const query = `
      SELECT id, session_id, version_number, cards_json, schema_version, source,
        validation_status, validation_errors_json, created_at
      FROM card_versions WHERE session_id = ? AND id = ?${profileId
        ? ' AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND anki_profile_id = ?)' : ''}`;
    return this.db.prepare(query).get(sessionId, id, ...(profileId ? [sessionId, profileId] : [])) || null;
  }

  listCardVersions (sessionId, profileId = null) {
    const query = `
      SELECT id, session_id, version_number, cards_json, schema_version, source,
        validation_status, validation_errors_json, created_at
      FROM card_versions WHERE session_id = ?${profileId
        ? ' AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND anki_profile_id = ?)' : ''}
      ORDER BY version_number DESC`;
    return this.db.prepare(query).all(sessionId, ...(profileId ? [sessionId, profileId] : []));
  }

  createCardVersion ({ sessionId, cards, schemaVersion, source, validationStatus, validationErrors = [],
    profileId = null }) {
    if (profileId && !this.getSession(sessionId, profileId)) throw new Error('Session not found');
    const latestVersion = this.db.prepare(`
      SELECT id, session_id, version_number, cards_json, schema_version, source,
        validation_status, validation_errors_json, created_at
      FROM card_versions
      WHERE session_id = ?
      ORDER BY version_number DESC
      LIMIT 1
    `).get(sessionId);
    if (latestVersion && stableJson(JSON.parse(latestVersion.cards_json)) === stableJson(cards)) {
      return { ...latestVersion, unchanged: true };
    }

    const timestamp = now();
    const version = this.db.prepare(`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
      FROM card_versions
      WHERE session_id = ?
    `).get(sessionId).next_version;
    const result = this.db.prepare(`
      INSERT INTO card_versions (
        session_id, version_number, cards_json, schema_version, source,
        validation_status, validation_errors_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      version,
      JSON.stringify(cards),
      schemaVersion,
      source,
      validationStatus,
      JSON.stringify(validationErrors),
      timestamp,
    );
    if (validationStatus === 'valid') {
      this.db.prepare(`
        UPDATE sessions
        SET current_card_version_id = ?, updated_at = ?
        WHERE id = ?
      `).run(result.lastInsertRowid, timestamp, sessionId);
    } else {
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(timestamp, sessionId);
    }
    return {
      ...this.db.prepare(`
      SELECT id, session_id, version_number, cards_json, schema_version, source,
        validation_status, validation_errors_json, created_at
      FROM card_versions
      WHERE id = ?
      `).get(result.lastInsertRowid),
      unchanged: false,
    };
  }
}

module.exports = Repository;
