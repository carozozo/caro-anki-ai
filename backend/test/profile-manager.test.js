const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDatabase } = require('../../sqlite/database');
const Repository = require('../../sqlite/repository');
const { ProfileManager, profileName } = require('../profile-manager');

function setup (t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caro-anki-profile-'));
  const profileRoot = path.join(tempDir, 'profiles');
  const source = path.join(profileRoot, 'User 1');
  fs.mkdirSync(path.join(source, 'collection.media'), { recursive: true });
  fs.mkdirSync(path.join(source, 'backups'));
  fs.writeFileSync(path.join(source, 'collection.anki2'), 'collection');
  fs.writeFileSync(path.join(source, 'collection.media', 'voice.mp3'), 'media');
  fs.writeFileSync(path.join(source, 'collection.media.db2'), 'media-index');
  fs.writeFileSync(path.join(source, 'backups', 'existing.colpkg'), 'old backup');
  const db = createDatabase({ dbPath: path.join(tempDir, 'app.sqlite'),
    migrationsDir: path.resolve(__dirname, '../../sqlite/migrations') });
  t.after(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const config = { profileRoot, collectionPath: path.join(source, 'collection.anki2') };
  const repository = new Repository(db);
  const manager = new ProfileManager({ repository, ankiConfig: config });
  const profile = manager.initialize();
  const calls = [];
  manager.attach({
    beginExclusive: () => calls.push('begin'), endExclusive: () => calls.push('end'),
    close: async () => calls.push('close'), setCollectionPath: value => calls.push(['path', value]),
  });
  return { tempDir, profileRoot, source, config, repository, manager, profile, calls };
}

test('validates a profile name before it can become a directory name', () => {
  assert.equal(profileName(' Caro '), 'Caro');
  assert.throws(() => profileName('../Caro'), /cannot contain a path separator/);
  assert.throws(() => profileName(''), /Profile name/);
  assert.throws(() => profileName('profile-backups'), /reserved/);
});

test('renames a managed profile with a backup and keeps its collection together', async t => {
  const { profileRoot, source, config, manager, profile, calls } = setup(t);
  const result = await manager.rename({ id: profile.id, name: 'Caro' });
  const target = path.join(profileRoot, 'Caro');

  assert.equal(result.profile.name, 'Caro');
  assert.equal(result.profile.storageName, 'Caro');
  assert.equal(result.reloadRequired, true);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(target, 'collection.anki2'), 'utf8'), 'collection');
  assert.equal(fs.readFileSync(path.join(target, 'collection.media', 'voice.mp3'), 'utf8'), 'media');
  assert.equal(fs.readFileSync(path.join(target, 'backups', 'existing.colpkg'), 'utf8'), 'old backup');
  assert.equal(config.collectionPath, path.join(target, 'collection.anki2'));
  assert.deepEqual(calls, ['begin', 'close', ['path', config.collectionPath], 'end']);
  const backupRoot = path.join(profileRoot, 'profile-backups', profile.id);
  const [backup] = fs.readdirSync(backupRoot);
  assert.equal(fs.readFileSync(path.join(backupRoot, backup, 'collection.anki2'), 'utf8'), 'collection');
  assert.equal(fs.readFileSync(path.join(backupRoot, backup, 'collection.media', 'voice.mp3'), 'utf8'), 'media');
});

test('does not move a profile into an existing folder', async t => {
  const { profileRoot, source, manager, profile, calls } = setup(t);
  fs.mkdirSync(path.join(profileRoot, 'Caro'));

  await assert.rejects(manager.rename({ id: profile.id, name: 'Caro' }), { code: 'profile_path_exists' });
  assert.equal(fs.existsSync(source), true);
  assert.deepEqual(calls, []);
});

test('recovers a completed directory move left in the migrating state', t => {
  const { profileRoot, source, config, repository, profile } = setup(t);
  const target = path.join(profileRoot, 'Caro');
  repository.beginAnkiProfileMigration(profile.id, {
    name: 'Caro', collectionPath: path.join(target, 'collection.anki2'),
  });
  fs.renameSync(source, target);
  const manager = new ProfileManager({ repository, ankiConfig: config });
  const active = manager.initialize();

  assert.equal(active.name, 'Caro');
  assert.equal(active.state, 'ready');
  assert.equal(config.collectionPath, path.join(target, 'collection.anki2'));
});

test('discovers the only managed collection when a stale legacy path is missing', async t => {
  const { profileRoot, source, repository, manager, profile } = setup(t);
  await manager.rename({ id: profile.id, name: 'Caro' });
  repository.db.prepare('UPDATE anki_profile_state SET active_profile_id = NULL WHERE id = 1').run();
  repository.db.prepare('DELETE FROM anki_profiles').run();
  const config = { profileRoot, collectionPath: path.join(source, 'collection.anki2') };
  const restarted = new ProfileManager({ repository, ankiConfig: config }).initialize();

  assert.equal(restarted.name, 'Caro');
  assert.equal(config.collectionPath, path.join(profileRoot, 'Caro', 'collection.anki2'));
});

test('creates a separate collection profile and activates it without touching the current one', async t => {
  const { profileRoot, source, config, repository, manager, calls } = setup(t);
  const activations = [];
  manager.attach({
    beginExclusive: () => calls.push('begin'), endExclusive: () => calls.push('end'),
    close: async () => calls.push('close'), setCollectionPath: value => calls.push(['path', value]),
  }, {
    createCollection: async collectionPath => {
      fs.mkdirSync(path.dirname(collectionPath), { recursive: true });
      fs.writeFileSync(collectionPath, 'new collection');
    },
    onActivate: profile => activations.push(profile.id),
  });

  const created = await manager.create({ name: 'Reading' });
  const target = path.join(profileRoot, 'Reading', 'collection.anki2');

  assert.equal(created.created, true);
  assert.equal(created.profile.active, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new collection');
  assert.equal(fs.readFileSync(path.join(source, 'collection.anki2'), 'utf8'), 'collection');
  assert.deepEqual(repository.getAnkiSettings(created.profile.id), {
    modelName: 'Caro', allowDuplicate: true, visibleDecks: [],
  });
  calls.length = 0;

  const activated = await manager.activate({ id: created.profile.id });
  assert.equal(activated.profile.active, true);
  assert.equal(config.collectionPath, target);
  assert.deepEqual(calls, ['begin', 'close', ['path', target], 'end']);
  assert.deepEqual(activations, [created.profile.id]);

  const restartedConfig = { profileRoot, collectionPath: path.join(profileRoot, 'User 1', 'collection.anki2') };
  const restarted = new ProfileManager({ repository, ankiConfig: restartedConfig }).initialize();
  assert.equal(restarted.id, created.profile.id);
  assert.equal(restartedConfig.collectionPath, target);
});

test('does not change profiles while an active request holds a collection lease', async t => {
  const { manager, repository } = setup(t);
  const alternate = path.join(manager.profileRoot, 'Reading', 'collection.anki2');
  fs.mkdirSync(path.dirname(alternate), { recursive: true });
  fs.writeFileSync(alternate, 'new collection');
  const id = 'reading';
  repository.beginAnkiProfileCreation({ id, name: 'Reading', collectionPath: alternate,
    stagingPath: path.join(manager.profileRoot, 'profile-staging', id) });
  repository.finishAnkiProfileCreation(id);
  let release;
  const leased = manager.useActive(() => new Promise(resolve => { release = resolve; }));

  await assert.rejects(manager.activate({ id }), { code: 'profile_busy' });
  release();
  await leased;
  assert.equal((await manager.activate({ id })).profile.id, id);
});

test('deletes an inactive profile with a copy of its collection and refuses the active one', async t => {
  const { profileRoot, repository, manager, profile, calls } = setup(t);
  const directory = path.join(profileRoot, 'Reading');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'collection.anki2'), 'reading collection');
  fs.writeFileSync(path.join(directory, 'extra.note'), 'kept');
  repository.beginAnkiProfileCreation({ id: 'reading', name: 'Reading',
    collectionPath: path.join(directory, 'collection.anki2'),
    stagingPath: path.join(profileRoot, 'profile-staging', 'reading') });
  repository.finishAnkiProfileCreation('reading');
  repository.createSession({ title: 'Reading work', profileId: 'reading' });
  calls.length = 0;

  await assert.rejects(manager.remove({ id: profile.id }), { code: 'profile_active' });
  assert.equal(fs.existsSync(path.join(profileRoot, 'User 1', 'collection.anki2')), true);

  const removed = await manager.remove({ id: 'reading' });

  assert.equal(removed.removed, 'Reading');
  assert.equal(removed.backupCreated, true);
  assert.equal(removed.activeProfileId, profile.id);
  assert.deepEqual(removed.profiles.map(item => item.name), ['User 1']);
  assert.equal(repository.getAnkiProfile('reading'), null);
  assert.deepEqual(repository.listSessions('reading'), []);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(calls, ['begin', 'end']);
  const backupRoot = path.join(profileRoot, 'profile-backups', 'reading');
  const [backup] = fs.readdirSync(backupRoot);
  assert.equal(fs.readFileSync(path.join(backupRoot, backup, 'collection.anki2'), 'utf8'), 'reading collection');
  assert.equal(fs.readFileSync(path.join(backupRoot, backup, 'extra.note'), 'utf8'), 'kept');
  assert.equal(fs.existsSync(path.join(backupRoot, backup, 'profile-removal.json')), true);
});

test('does not delete a collection that lives outside the profile folder', async t => {
  const { tempDir, repository, manager } = setup(t);
  const external = path.join(tempDir, 'external', 'collection.anki2');
  fs.mkdirSync(path.dirname(external), { recursive: true });
  fs.writeFileSync(external, 'external collection');
  repository.beginAnkiProfileCreation({ id: 'external', name: 'External', collectionPath: external,
    stagingPath: path.join(manager.profileRoot, 'profile-staging', 'external') });
  repository.finishAnkiProfileCreation('external');

  await assert.rejects(manager.remove({ id: 'external' }), { code: 'external_profile' });
  assert.equal(fs.readFileSync(external, 'utf8'), 'external collection');
});
