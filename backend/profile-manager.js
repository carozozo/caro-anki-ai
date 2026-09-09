const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const COLLECTION_FILE = 'collection.anki2';
const PROFILE_STAGING_DIRECTORY = 'profile-staging';
const RESERVED_STORAGE_NAMES = new Set(['profile-backups', PROFILE_STAGING_DIRECTORY]);
const SNAPSHOT_ENTRIES = [COLLECTION_FILE, `${COLLECTION_FILE}-wal`, `${COLLECTION_FILE}-shm`,
  'collection.media', 'collection.media.db2'];

const fail = (message, statusCode = 400, code) => {
  const error = Object.assign(new Error(message), { statusCode });
  if (code) error.code = code;
  throw error;
};

const profileName = value => {
  const name = String(value || '').trim().normalize('NFC');
  if (!name || name.length > 64 || name === '.' || name === '..' || /[\\/:\0\p{C}]/u.test(name)) {
    fail('Profile name must be 1–64 characters and cannot contain a path separator.');
  }
  if (RESERVED_STORAGE_NAMES.has(name.toLocaleLowerCase())) fail('That profile name is reserved.');
  return name;
};

const exists = target => fs.existsSync(target);

function directorySummary (directory) {
  let files = 0, bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = directorySummary(target);
      files += nested.files; bytes += nested.bytes;
    } else {
      files += 1; bytes += fs.lstatSync(target).size;
    }
  }
  return { files, bytes };
}

function entrySummary (directory, name) {
  const target = path.join(directory, name);
  if (!exists(target)) return null;
  const stat = fs.lstatSync(target);
  return stat.isDirectory() ? { type: 'directory', ...directorySummary(target) }
    : { type: 'file', bytes: stat.size };
}

const collectionSnapshot = directory => Object.fromEntries(SNAPSHOT_ENTRIES
  .map(name => [name, entrySummary(directory, name)]));

const backupPath = (profileRoot, profileId) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(profileRoot, 'profile-backups', profileId, stamp);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  return backup;
};

const writeBackupRecord = (backup, { reason, directory, snapshot }) => {
  fs.writeFileSync(path.join(backup, `profile-${reason}.json`), JSON.stringify({ reason,
    createdAt: new Date().toISOString(), source: path.basename(directory), snapshot }, null, 2));
  return backup;
};

// A renamed folder still sits next to its copy for a moment, so only the entries that make up a collection
// are copied. A removed folder is deleted outright, so every file in it is kept.
function copyMigrationBackup ({ directory, profileRoot, profileId, snapshot }) {
  const backup = backupPath(profileRoot, profileId);
  fs.mkdirSync(backup, { recursive: false });
  for (const name of SNAPSHOT_ENTRIES) {
    const source = path.join(directory, name);
    if (exists(source)) fs.cpSync(source, path.join(backup, name), {
      recursive: fs.lstatSync(source).isDirectory(), preserveTimestamps: true, errorOnExist: true, force: false,
    });
  }
  return writeBackupRecord(backup, { reason: 'migration', directory, snapshot });
}

function copyRemovalBackup ({ directory, profileRoot, profileId, snapshot }) {
  const backup = backupPath(profileRoot, profileId);
  fs.cpSync(directory, backup, { recursive: true, preserveTimestamps: true });
  return writeBackupRecord(backup, { reason: 'removal', directory, snapshot });
}

class ProfileManager {
  constructor ({ repository, ankiConfig }) {
    this.repository = repository;
    this.ankiConfig = ankiConfig;
    this.profileRoot = path.resolve(ankiConfig.profileRoot);
    this.client = null;
    this.createCollection = null;
    this.onActivate = null;
    this.beforeChange = null;
    this.changing = false;
    this.leaseCount = 0;
  }

  initialize () {
    this.recover();
    let active = this.repository.getActiveAnkiProfile();
    let created = false;
    if (!active) {
      const collectionPath = this.bootstrapCollectionPath();
      ({ profile: active, created } = this.repository.ensureAnkiProfile({
        name: path.basename(path.dirname(collectionPath)), collectionPath,
      }));
    }
    if (!created && !exists(active.collectionPath)) {
      fail(`The ${active.name} profile collection is missing. Restore it before opening Caro Anki.`, 503,
        'profile_collection_missing');
    }
    this.repository.ensureAnkiProfileSettings(active.id, { copyLegacy: true });
    this.repository.bindLegacySessionsToProfile(active.id);
    this.apply(active);
    return active;
  }

  attach (client, { createCollection = null, onActivate = null, beforeChange = null } = {}) {
    Object.assign(this, { client, createCollection, onActivate, beforeChange });
  }

  active () {
    const profile = this.repository.getActiveAnkiProfile();
    if (!profile) fail('No active Anki profile is configured.', 503, 'profile_missing');
    return profile;
  }

  managed (collectionPath) {
    const file = path.resolve(collectionPath);
    const directory = path.dirname(file);
    return path.basename(file) === COLLECTION_FILE && path.dirname(directory) === this.profileRoot;
  }

  view (profile, activeId = this.active().id) {
    return {
      id: profile.id, name: profile.name, storageName: path.basename(path.dirname(profile.collectionPath)),
      state: profile.state, active: profile.id === activeId, managed: this.managed(profile.collectionPath),
      canRename: profile.state === 'ready' && this.managed(profile.collectionPath),
      canActivate: profile.state === 'ready' && exists(profile.collectionPath),
    };
  }

  list () {
    const active = this.active();
    return { activeProfileId: active.id, profiles: this.repository.listAnkiProfiles()
      .map(profile => this.view(profile, active.id)) };
  }

  apply (profile) { this.ankiConfig.collectionPath = profile.collectionPath; }

  bootstrapCollectionPath () {
    const active = this.repository.getActiveAnkiProfile();
    if (active) return active.collectionPath;
    const configured = this.ankiConfig.collectionPath;
    if (exists(configured) || !this.managed(configured) || !exists(this.profileRoot)) return configured;
    const candidates = fs.readdirSync(this.profileRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !RESERVED_STORAGE_NAMES.has(entry.name.toLocaleLowerCase()))
      .map(entry => path.join(this.profileRoot, entry.name, COLLECTION_FILE)).filter(exists);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) fail('More than one collection profile needs recovery. Do not create a new one.', 503,
      'profile_migration_recovery');
    return configured;
  }

  targetPath (name) {
    const directory = path.resolve(this.profileRoot, name);
    if (path.dirname(directory) !== this.profileRoot) fail('Profile path is outside Caro Anki storage.');
    return path.join(directory, COLLECTION_FILE);
  }

  stagingPath (id) {
    return path.join(this.profileRoot, PROFILE_STAGING_DIRECTORY, id);
  }

  recover () {
    for (const profile of this.repository.listAnkiProfiles().filter(item => item.state === 'migrating')) {
      const source = exists(profile.collectionPath);
      const target = Boolean(profile.pendingCollectionPath && exists(profile.pendingCollectionPath));
      if (!source && target) this.repository.finishAnkiProfileMigration(profile.id);
      else if (source && !target) this.repository.cancelAnkiProfileMigration(profile.id);
      else fail(`Profile migration for ${profile.name} needs recovery. Do not edit either folder.`, 503,
        'profile_migration_recovery');
    }
    for (const creation of this.repository.listAnkiProfileCreations()) {
      const staged = exists(creation.stagingPath);
      const target = exists(creation.collectionPath);
      if (staged && !target) fs.renameSync(creation.stagingPath, path.dirname(creation.collectionPath));
      else if (staged && target) fail(`Profile creation for ${creation.name} needs recovery.`, 503,
        'profile_creation_recovery');
      if (exists(creation.collectionPath)) this.repository.finishAnkiProfileCreation(creation.id);
      else this.repository.cancelAnkiProfileCreation(creation.id);
    }
  }

  useActive (operation) {
    if (this.changing) fail('The collection profile is changing. Try again in a moment.', 409, 'profile_changing');
    const profile = this.active();
    const lease = { profileId: profile.id };
    this.leaseCount += 1;
    return Promise.resolve().then(() => operation(lease)).finally(() => { this.leaseCount -= 1; });
  }

  beginChange () {
    if (!this.client || this.changing || this.leaseCount) {
      fail('The profile is busy. Try again when the current task ends.', 409, 'profile_busy');
    }
    this.beforeChange?.();
    this.client.beginExclusive();
    this.changing = true;
  }

  endChange () {
    this.changing = false;
    this.client.endExclusive();
  }

  validateRename (profile, name) {
    const nextName = profileName(name);
    const duplicate = this.repository.listAnkiProfiles()
      .find(item => item.id !== profile.id
        && item.name.localeCompare(nextName, undefined, { sensitivity: 'accent' }) === 0);
    if (duplicate) fail('A profile with that name already exists.');
    if (!this.managed(profile.collectionPath)) {
      fail('This external collection cannot be renamed by Caro Anki.', 409, 'external_profile');
    }
    if (profile.state !== 'ready') fail('This profile is still recovering a previous migration.', 409);
    return nextName;
  }

  validateCreate (name) {
    const nextName = profileName(name);
    const duplicate = [...this.repository.listAnkiProfiles(), ...this.repository.listAnkiProfileCreations()]
      .find(profile => profile.name.localeCompare(nextName, undefined, { sensitivity: 'accent' }) === 0);
    if (duplicate) fail('A profile with that name already exists.');
    const targetPath = this.targetPath(nextName);
    if (exists(path.dirname(targetPath))) fail('A profile folder with that name already exists.', 409,
      'profile_path_exists');
    return { name: nextName, collectionPath: targetPath };
  }

  async create ({ name }) {
    const plan = this.validateCreate(name);
    if (!this.createCollection) fail('The profile creator is unavailable.', 503);
    const id = randomUUID();
    const stagingPath = this.stagingPath(id);
    this.beginChange();
    try {
      this.repository.beginAnkiProfileCreation({ ...plan, id, stagingPath });
      fs.mkdirSync(stagingPath, { recursive: true });
      await this.createCollection(path.join(stagingPath, COLLECTION_FILE));
      if (!exists(path.join(stagingPath, COLLECTION_FILE))) fail('The new collection was not created.', 503);
      fs.renameSync(stagingPath, path.dirname(plan.collectionPath));
      const profile = this.repository.finishAnkiProfileCreation(id);
      return { profile: this.view(profile), created: true };
    } catch (error) {
      const creation = this.repository.getAnkiProfileCreation(id);
      if (creation && exists(creation.stagingPath) && !exists(creation.collectionPath)) {
        this.repository.cancelAnkiProfileCreation(id);
        fs.rmSync(creation.stagingPath, { recursive: true, force: true });
      }
      throw error;
    } finally {
      this.endChange();
    }
  }

  async activate ({ id }) {
    const current = this.active();
    const profile = this.repository.getAnkiProfile(id);
    if (!profile) fail('Profile not found.', 404);
    if (profile.id === current.id) return { profile: this.view(profile), reloadRequired: false };
    if (profile.state !== 'ready') fail('This profile is still recovering a previous migration.', 409);
    if (!exists(profile.collectionPath)) fail('The profile collection is missing.', 503, 'profile_collection_missing');

    this.beginChange();
    try {
      await this.client.close();
      this.repository.setActiveAnkiProfile(profile.id);
      this.apply(profile);
      this.client.setCollectionPath(profile.collectionPath);
      this.onActivate?.(profile);
      return { profile: this.view(profile), reloadRequired: true };
    } catch (error) {
      this.repository.setActiveAnkiProfile(current.id);
      this.apply(current);
      this.client.setCollectionPath(current.collectionPath);
      this.onActivate?.(current);
      throw error;
    } finally {
      this.endChange();
    }
  }

  // Deleting is the one action that destroys a collection, so the folder is copied into `profile-backups`
  // first. The active profile is refused outright: something has to stay open, so the user switches first and
  // the profile being deleted is never the one the client is reading.
  async remove ({ id }) {
    const profile = this.repository.getAnkiProfile(id);
    if (!profile) fail('Profile not found.', 404);
    if (profile.id === this.active().id) {
      fail('The active profile cannot be deleted. Switch to another profile first.', 409, 'profile_active');
    }
    if (profile.state !== 'ready') fail('This profile is still recovering a previous migration.', 409);
    if (!this.managed(profile.collectionPath)) {
      fail('This external collection cannot be deleted by Caro Anki.', 409, 'external_profile');
    }
    const directory = path.dirname(profile.collectionPath);
    this.beginChange();
    try {
      const backup = exists(directory) ? copyRemovalBackup({ directory, profileRoot: this.profileRoot,
        profileId: profile.id, snapshot: collectionSnapshot(directory) }) : null;
      fs.rmSync(directory, { recursive: true, force: true });
      this.repository.deleteAnkiProfile(profile.id);
      return { removed: profile.name, backupCreated: Boolean(backup), ...this.list() };
    } finally {
      this.endChange();
    }
  }

  async rename ({ id, name }) {
    const profile = this.repository.getAnkiProfile(id);
    if (!profile || profile.id !== this.active().id) fail('Profile not found.', 404);
    const nextName = this.validateRename(profile, name);
    const sourceDirectory = path.dirname(profile.collectionPath);
    const targetPath = this.targetPath(nextName);
    const targetDirectory = path.dirname(targetPath);
    if (targetPath === profile.collectionPath) return this.repository.renameAnkiProfile(profile.id, nextName);
    if (exists(targetDirectory)) fail('A profile folder with that name already exists.', 409, 'profile_path_exists');
    if (!exists(profile.collectionPath)) fail('The profile collection is missing.', 503, 'profile_collection_missing');
    this.beginChange();
    try {
      await this.client.close();
      const snapshot = collectionSnapshot(sourceDirectory);
      const backup = copyMigrationBackup({ directory: sourceDirectory, profileRoot: this.profileRoot,
        profileId: profile.id, snapshot });
      this.repository.beginAnkiProfileMigration(profile.id, { name: nextName, collectionPath: targetPath });
      fs.renameSync(sourceDirectory, targetDirectory);
      if (JSON.stringify(snapshot) !== JSON.stringify(collectionSnapshot(targetDirectory))) {
        fail('The profile moved but its verification failed. Restart Caro Anki to recover it.', 503,
          'profile_migration_verification');
      }
      const moved = this.repository.finishAnkiProfileMigration(profile.id);
      this.apply(moved);
      this.client.setCollectionPath(moved.collectionPath);
      return { profile: this.view(moved), backupCreated: Boolean(backup), reloadRequired: true };
    } catch (error) {
      const current = this.repository.getAnkiProfile(profile.id);
      if (current?.state === 'migrating' && exists(profile.collectionPath) && !exists(targetPath)) {
        this.repository.cancelAnkiProfileMigration(profile.id);
      }
      throw error;
    } finally {
      this.endChange();
    }
  }
}

module.exports = { ProfileManager, collectionSnapshot, profileName };
