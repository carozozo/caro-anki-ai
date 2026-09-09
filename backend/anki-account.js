const { syncPerformed, syncRequired } = require('./anki-local');
const syncProgress = require('./sync-progress');

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const syncAnswer = required => ({ required, needsSync: required !== 'NO_CHANGES' });

const FULL_SYNC_DIRECTIONS = ['upload', 'download'];
const LEGACY_KEYCHAIN_ACCOUNT = 'ankiweb-password';

function normalizeEndpoint (value) {
  const endpoint = String(value || '').trim();
  if (!endpoint) return null;
  let url;
  try { url = new URL(endpoint); } catch { throw fail('Sync server URL is not valid'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw fail('Sync server URL must use HTTP or HTTPS');
  return url.toString();
}

// Owns the AnkiWeb account: the user ID, endpoint, and media preference live in SQLite, while the
// password never leaves the macOS Keychain. The collection itself is written by the Anki runtime.
class AnkiAccount {
  constructor ({ repository, keychain, client, profileId = null, legacyProfileId = null }) {
    Object.assign(this, { repository, keychain, client, profileId, legacyProfileId });
    this.keychainAccount = this.keychainAccountFor(profileId);
  }

  keychainAccountFor (profileId = this.profileId) {
    return profileId ? `${LEGACY_KEYCHAIN_ACCOUNT}:${profileId}` : LEGACY_KEYCHAIN_ACCOUNT;
  }

  activate (profileId) {
    this.profileId = profileId;
    this.keychainAccount = this.keychainAccountFor(profileId);
  }

  async password (profileId = this.profileId) {
    const account = this.keychainAccountFor(profileId);
    const password = await this.keychain.get(account);
    if (password || !profileId || profileId !== this.legacyProfileId) return password;
    const legacy = await this.keychain.get(LEGACY_KEYCHAIN_ACCOUNT);
    if (legacy) {
      await this.keychain.set(account, legacy);
      await this.keychain.delete(LEGACY_KEYCHAIN_ACCOUNT);
    }
    return legacy;
  }

  async settings (profileId = this.profileId) {
    const settings = this.repository.getAnkiSyncSettings(profileId);
    return { ...settings, loggedIn: Boolean(settings.username && await this.password(profileId)) };
  }

  // The credentials are verified against AnkiWeb before anything is stored, so a rejected password
  // never leaves a half-configured account behind.
  async login ({ username, password, endpoint, media = true } = {}) {
    const profileId = this.profileId;
    const account = {
      username: String(username || '').trim(),
      password: String(password || ''),
      endpoint: normalizeEndpoint(endpoint),
      media,
    };
    if (!account.username || !account.password) throw fail('AnkiWeb ID and password are required');
    if (typeof account.media !== 'boolean') throw fail('media must be a boolean');
    const authenticated = await this.client.authenticate(account);
    await this.keychain.set(this.keychainAccountFor(profileId), account.password);
    if (profileId && profileId === this.legacyProfileId) await this.keychain.delete(LEGACY_KEYCHAIN_ACCOUNT);
    this.repository.updateAnkiSyncSettings({
      username: account.username,
      endpoint: account.endpoint || authenticated?.newEndpoint || null,
      media: account.media,
    }, profileId);
    return this.settings(profileId);
  }

  async logout () {
    const profileId = this.profileId;
    const current = this.repository.getAnkiSyncSettings(profileId);
    await this.keychain.delete(this.keychainAccountFor(profileId));
    if (profileId && profileId === this.legacyProfileId) await this.keychain.delete(LEGACY_KEYCHAIN_ACCOUNT);
    this.repository.updateAnkiSyncSettings({ ...current, username: '' }, profileId);
    return this.settings(profileId);
  }

  // A `direction` is only sent after the user has seen a full-sync prompt: AnkiWeb refuses anything
  // else, so the first sync returns `required` and the UI decides. The states Anki reports during the
  // sync land in the shared snapshot, because a running sync holds the bridge and the UI therefore
  // cannot ask it anything; `finally` closes that snapshot on every path, a failure included, so a
  // failed sync cannot leave the UI polling a run that already ended.
  async sync ({ direction = null } = {}) {
    if (direction !== null && !FULL_SYNC_DIRECTIONS.includes(direction)) {
      throw fail(`direction must be ${FULL_SYNC_DIRECTIONS.join(' or ')}`);
    }
    const profileId = this.profileId;
    const settings = this.repository.getAnkiSyncSettings(profileId);
    const password = await this.password(profileId);
    if (!settings.username || !password) throw fail('Log in to AnkiWeb before syncing', 401);
    syncProgress.begin(direction);
    try {
      const { stamps, ...result } = await this.client.syncCollection({
        ...settings, password, direction,
        onProgress: syncProgress.record
      });
      // AnkiWeb reports the account's shard on first contact; remember it so later syncs skip a redirect.
      if (result.newEndpoint && result.newEndpoint !== settings.endpoint) {
        this.repository.updateAnkiSyncSettings({ ...settings, endpoint: result.newEndpoint }, profileId);
      }
      // AnkiWeb answers NO_CHANGES after a merge it just performed as well as when there was nothing to do,
      // so the UI cannot read the outcome off `required`: the stamp the sync wrote when it finalized is
      // what says data moved. The raw stamps stay here — they are the bridge's bookkeeping.
      return { ...result, merged: Boolean(result.fullSync) || syncPerformed(stamps) };
    } finally {
      syncProgress.end();
    }
  }

  // The check behind the UI's "needs sync" reminder, mirroring Anki Desktop's own status call. A
  // signed-out account reports nothing — Anki answers NO_CHANGES without looking, because with no server
  // to compare against, "there is something to upload" is not something the reminder can act on; the
  // account control is what shows the signed-out state. Otherwise the local stamps decide first, so
  // unpublished local changes never touch the network, and only a clean collection asks AnkiWeb. Errors
  // belong to the caller: a failed check must never raise a reminder.
  async syncStatus () {
    const profileId = this.profileId;
    const settings = this.repository.getAnkiSyncSettings(profileId);
    const password = settings.username ? await this.password(profileId) : null;
    if (!password) return syncAnswer('NO_CHANGES');
    const local = syncRequired(await this.client.syncStamps());
    if (local !== 'NO_CHANGES') return syncAnswer(local);
    const remote = await this.client.syncCheck({ ...settings, password });
    // AnkiWeb reports the account's shard here too, so a check can save the next sync a redirect.
    if (remote.newEndpoint && remote.newEndpoint !== settings.endpoint) {
      this.repository.updateAnkiSyncSettings({ ...settings, endpoint: remote.newEndpoint }, profileId);
    }
    return syncAnswer(remote.required);
  }
}

module.exports = { AnkiAccount, FULL_SYNC_DIRECTIONS, normalizeEndpoint };
