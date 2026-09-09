const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createDatabase } = require('../../sqlite/database');
const Repository = require('../../sqlite/repository');
const { AnkiAccount, normalizeEndpoint } = require('../anki-account');

const PASSWORD_ACCOUNT = 'ankiweb-password';

// The real store shells out to `security`; the tests never touch it, so no test can read or write the
// user's actual AnkiWeb password.
class FakeKeychain {
  constructor (entries = {}) {
    this.entries = new Map(Object.entries(entries));
    this.writes = [];
  }

  async get (account) { return this.entries.get(account) ?? null; }

  async set (account, secret) {
    this.writes.push(['set', account, secret]);
    this.entries.set(account, secret);
  }

  async delete (account) {
    this.writes.push(['delete', account]);
    this.entries.delete(account);
  }
}

const setup = (t, { entries, client } = {}) => {
  const db = createDatabase({
    dbPath: ':memory:', migrationsDir: path.resolve(__dirname, '../../sqlite/migrations'),
  });
  t.after(() => db.close());
  const calls = [];
  const fakeClient = client || {
    authenticate: async params => { calls.push({ authenticate: params }); return { newEndpoint: null }; },
    syncCollection: async params => {
      calls.push({ syncCollection: params });
      return { required: 'NORMAL_SYNC', serverMessage: '', newEndpoint: null, fullSync: params.direction };
    },
  };
  const repository = new Repository(db);
  const keychain = new FakeKeychain(entries);
  return { repository, keychain, calls, account: new AnkiAccount({ repository, keychain, client: fakeClient }) };
};

test('an untouched account is logged out and keeps the collection defaults', async t => {
  const { account } = setup(t);
  assert.deepEqual(await account.settings(), { username: '', endpoint: null, media: true, loggedIn: false });
});

test('login verifies the credentials before anything is stored', async t => {
  const { account, keychain, repository } = setup(t, {
    client: {
      authenticate: async () => { throw new Error('Anki: auth failed'); },
      syncCollection: async () => { throw new Error('the sync must not run'); },
    },
  });

  await assert.rejects(account.login({ username: 'user@example.com', password: 'wrong' }),
    /Anki: auth failed/);
  assert.deepEqual(keychain.writes, []);
  assert.deepEqual(repository.getAnkiSyncSettings(), { username: '', endpoint: null, media: true });
});

test('login keeps the password in the Keychain and the rest in SQLite', async t => {
  const { account, keychain, repository } = setup(t);

  const settings = await account.login({ username: ' user@example.com ', password: 'secret', media: false });

  assert.deepEqual(keychain.writes, [['set', PASSWORD_ACCOUNT, 'secret']]);
  assert.deepEqual(repository.getAnkiSyncSettings(), {
    username: 'user@example.com', endpoint: null, media: false,
  });
  assert.deepEqual(settings, {
    username: 'user@example.com', endpoint: null, media: false, loggedIn: true,
  });
});

test('login adopts the sync server AnkiWeb reports when none was configured', async t => {
  const { account, repository } = setup(t, {
    client: {
      authenticate: async () => ({ newEndpoint: 'https://sync34.ankiweb.net/' }),
      syncCollection: async () => { throw new Error('the sync must not run'); },
    },
  });

  const settings = await account.login({ username: 'user@example.com', password: 'secret' });

  assert.equal(settings.endpoint, 'https://sync34.ankiweb.net/');
  assert.equal(repository.getAnkiSyncSettings().endpoint, 'https://sync34.ankiweb.net/');
});

test('an explicit sync server always wins over the reported one', async t => {
  const { account } = setup(t, {
    client: {
      authenticate: async () => ({ newEndpoint: 'https://sync34.ankiweb.net/' }),
      syncCollection: async () => { throw new Error('the sync must not run'); },
    },
  });

  const settings = await account.login({
    username: 'user@example.com', password: 'secret', endpoint: 'https://self.hosted/',
  });

  assert.equal(settings.endpoint, 'https://self.hosted/');
});

test('login rejects incomplete credentials and an unusable sync server', async t => {
  const { account, calls } = setup(t);

  await assert.rejects(account.login({ password: 'secret' }), { statusCode: 400 });
  await assert.rejects(account.login({ username: 'user@example.com' }), { statusCode: 400 });
  await assert.rejects(account.login({ username: 'user@example.com', password: 'secret', media: 'yes' }),
    { statusCode: 400 });
  await assert.rejects(account.login({
    username: 'user@example.com', password: 'secret', endpoint: 'ftp://example.com/',
  }), /must use HTTP or HTTPS/);
  await assert.rejects(account.login({
    username: 'user@example.com', password: 'secret', endpoint: 'not a url',
  }), /not valid/);
  assert.deepEqual(calls, []);
});

test('logout clears the password and the user ID but keeps the sync preferences', async t => {
  const { account, keychain, repository } = setup(t, { entries: { [PASSWORD_ACCOUNT]: 'secret' } });
  await account.login({ username: 'user@example.com', password: 'secret', endpoint: 'https://self.hosted/' });

  const settings = await account.logout();

  assert.deepEqual(settings, {
    username: '', endpoint: 'https://self.hosted/', media: true, loggedIn: false,
  });
  assert.deepEqual(keychain.writes.at(-1), ['delete', PASSWORD_ACCOUNT]);
  assert.equal(repository.getAnkiSyncSettings().username, '');
});

test('a user ID without a stored password still counts as logged out', async t => {
  const { account } = setup(t);
  await account.login({ username: 'user@example.com', password: 'secret' });
  await account.keychain.delete(PASSWORD_ACCOUNT);

  assert.equal((await account.settings()).loggedIn, false);
});

test('sync refuses to run before an account is logged in', async t => {
  const { account, calls } = setup(t);

  await assert.rejects(account.sync(), error => {
    assert.equal(error.statusCode, 401);
    assert.match(error.message, /Log in to AnkiWeb/);
    return true;
  });
  assert.deepEqual(calls, []);
});

test('sync sends the stored account, the password, and the requested direction', async t => {
  const { account, calls } = setup(t, { entries: { [PASSWORD_ACCOUNT]: 'secret' } });
  await account.login({ username: 'user@example.com', password: 'secret', endpoint: 'https://self.hosted/' });

  const result = await account.sync();
  const full = await account.sync({ direction: 'download' });

  assert.equal(result.required, 'NORMAL_SYNC');
  assert.equal(full.fullSync, 'download');
  // Every sync reports into the shared progress snapshot, because a running sync holds the bridge and the
  // UI can only read that snapshot; the rest of the call is the stored account plus the requested direction.
  const { onProgress, ...sent } = calls.at(-1).syncCollection;
  assert.equal(typeof onProgress, 'function');
  assert.deepEqual(sent, {
    username: 'user@example.com', password: 'secret', endpoint: 'https://self.hosted/',
    media: true, direction: 'download',
  });
});

// Anki answers NO_CHANGES after a merge it has just performed as well as when there was nothing to do, so
// the account derives the outcome from the stamp the sync wrote instead of trusting the code — and drops the
// raw stamps, because `merged` is the one fact the UI needs.
test('sync reports a merge from the collection stamps, not from the code Anki answers with', async t => {
  const { account } = setup(t, {
    entries: { [PASSWORD_ACCOUNT]: 'secret' },
    client: {
      authenticate: async () => ({ newEndpoint: null }),
      syncCollection: async () => ({
        required: 'NO_CHANGES', serverMessage: '', newEndpoint: null, fullSync: null,
        stamps: { before: { mod: 500, scm: 10, lastSync: 100 }, after: { mod: 500, scm: 10, lastSync: 500 } },
      }),
    },
  });
  await account.login({ username: 'user@example.com', password: 'secret' });

  assert.deepEqual(await account.sync(), {
    required: 'NO_CHANGES', serverMessage: '', newEndpoint: null, fullSync: null, merged: true,
  });
});

test('sync remembers the shard endpoint AnkiWeb reports', async t => {
  const { account, repository } = setup(t, {
    entries: { [PASSWORD_ACCOUNT]: 'secret' },
    client: {
      authenticate: async () => ({ newEndpoint: null }),
      syncCollection: async () => ({
        required: 'NORMAL_SYNC', serverMessage: '', newEndpoint: 'https://sync34.ankiweb.net/', fullSync: null,
      }),
    },
  });
  await account.login({ username: 'user@example.com', password: 'secret' });

  await account.sync();

  assert.equal(repository.getAnkiSyncSettings().endpoint, 'https://sync34.ankiweb.net/');
});

test('sync rejects an unknown direction before calling the collection', async t => {
  const { account, calls } = setup(t, { entries: { [PASSWORD_ACCOUNT]: 'secret' } });
  await account.login({ username: 'user@example.com', password: 'secret' });

  await assert.rejects(account.sync({ direction: 'merge' }), error => {
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /direction must be upload or download/);
    return true;
  });
  assert.equal(calls.some(call => call.syncCollection), false);
});

// The check behind the reminder is layered on purpose, so these tests record which layer ran: a
// signed-out account answers without touching the collection, a local change is answered by the stamps
// alone, and only a clean signed-in collection reaches the server.
const statusSetup = async (t, { stamps, required, newEndpoint = null, signedIn = false } = {}) => {
  const calls = [];
  const context = setup(t, {
    client: {
      authenticate: async () => ({ newEndpoint: null }),
      syncStamps: async () => { calls.push('syncStamps'); return stamps; },
      syncCheck: async params => { calls.push({ syncCheck: params }); return { required, newEndpoint }; },
    },
  });
  if (signedIn) await context.account.login({ username: 'user@example.com', password: 'secret' });
  return { ...context, calls };
};

// Anki answers NO_CHANGES for a signed-out account without looking, because with no server to compare
// against a pending sync is not something the reminder can act on. The account control shows that state.
test('a signed-out account reports nothing and never reads the collection', async t => {
  const { account, calls } = await statusSetup(t, { stamps: { mod: 200, scm: 200, lastSync: 0 } });

  assert.deepEqual(await account.syncStatus(), { required: 'NO_CHANGES', needsSync: false });
  assert.deepEqual(calls, []);
});

// A user ID whose password is gone is signed out too, so the check stops before the collection.
test('a missing stored password reports nothing instead of checking', async t => {
  const { account, calls } = await statusSetup(t, {
    stamps: { mod: 200, scm: 200, lastSync: 0 }, signedIn: true,
  });
  await account.keychain.delete(PASSWORD_ACCOUNT);

  assert.deepEqual(await account.syncStatus(), { required: 'NO_CHANGES', needsSync: false });
  assert.deepEqual(calls, []);
});

// Unpublished local changes are the one case the reminder can act on without help, so AnkiWeb is not
// asked at all — the stamps already answer.
test('local changes are answered by the collection stamps, without asking AnkiWeb', async t => {
  const dirty = await statusSetup(t, {
    stamps: { mod: 200, scm: 100, lastSync: 100 }, required: 'NO_CHANGES', signedIn: true,
  });
  assert.deepEqual(await dirty.account.syncStatus(), { required: 'NORMAL_SYNC', needsSync: true });
  assert.deepEqual(dirty.calls, ['syncStamps']);

  const schema = await statusSetup(t, {
    stamps: { mod: 100, scm: 200, lastSync: 100 }, required: 'NO_CHANGES', signedIn: true,
  });
  assert.deepEqual(await schema.account.syncStatus(), { required: 'FULL_SYNC', needsSync: true });
  assert.deepEqual(schema.calls, ['syncStamps']);
});

// A clean collection still receives changes made elsewhere (a phone or AnkiWeb's editor), which only the
// server can report — so that is the one case that asks, with the account's own credentials.
test('a clean collection lets AnkiWeb answer, and remembers the shard it reports', async t => {
  const { account, repository, calls } = await statusSetup(t, {
    stamps: { mod: 100, scm: 100, lastSync: 100 },
    required: 'NORMAL_SYNC', newEndpoint: 'https://sync34.ankiweb.net/', signedIn: true,
  });

  assert.deepEqual(await account.syncStatus(), { required: 'NORMAL_SYNC', needsSync: true });
  assert.deepEqual(calls, ['syncStamps', { syncCheck: {
    username: 'user@example.com', endpoint: null, media: true, password: 'secret',
  } }]);
  assert.equal(repository.getAnkiSyncSettings().endpoint, 'https://sync34.ankiweb.net/');
});

test('an up-to-date collection asks AnkiWeb and reports the clean answer', async t => {
  const { account, calls } = await statusSetup(t, {
    stamps: { mod: 100, scm: 100, lastSync: 100 }, required: 'NO_CHANGES', signedIn: true,
  });

  assert.deepEqual(await account.syncStatus(), { required: 'NO_CHANGES', needsSync: false });
  assert.equal(calls.length, 2);
});

test('normalizeEndpoint accepts an HTTP server and treats blank as AnkiWeb', () => {
  assert.equal(normalizeEndpoint(''), null);
  assert.equal(normalizeEndpoint(undefined), null);
  assert.equal(normalizeEndpoint('https://sync.example.com/'), 'https://sync.example.com/');
  assert.throws(() => normalizeEndpoint('ftp://sync.example.com/'), /must use HTTP or HTTPS/);
});

test('keeps AnkiWeb credentials separate for each collection profile', async t => {
  const { repository, keychain, calls } = setup(t);
  const first = repository.ensureAnkiProfile({
    name: 'Caro', collectionPath: '/profiles/Caro/collection.anki2',
  }).profile;
  repository.ensureAnkiProfileSettings(first.id);
  repository.beginAnkiProfileCreation({
    id: 'reading', name: 'Reading', collectionPath: '/profiles/Reading/collection.anki2',
    stagingPath: '/profiles/profile-staging/reading',
  });
  const second = repository.finishAnkiProfileCreation('reading');
  const client = {
    authenticate: async params => { calls.push({ authenticate: params }); return { newEndpoint: null }; },
    syncCollection: async () => ({ required: 'NO_CHANGES', stamps: {} }),
  };
  const carol = new AnkiAccount({ repository, keychain, client, profileId: first.id, legacyProfileId: first.id });
  const reading = new AnkiAccount({ repository, keychain, client, profileId: second.id, legacyProfileId: first.id });

  await carol.login({ username: 'caro@example.com', password: 'caro-secret' });

  assert.equal((await carol.settings()).loggedIn, true);
  assert.deepEqual(await reading.settings(), { username: '', endpoint: null, media: true, loggedIn: false });
  assert.deepEqual(keychain.writes[0], ['set', `${PASSWORD_ACCOUNT}:${first.id}`, 'caro-secret']);
});

test('moves the legacy password into the first collection profile only once', async t => {
  const { repository, keychain, calls } = setup(t, { entries: { [PASSWORD_ACCOUNT]: 'legacy-secret' } });
  const profile = repository.ensureAnkiProfile({
    name: 'Caro', collectionPath: '/profiles/Caro/collection.anki2',
  }).profile;
  repository.ensureAnkiProfileSettings(profile.id);
  repository.updateAnkiSyncSettings({ username: 'caro@example.com', endpoint: null, media: true }, profile.id);
  const account = new AnkiAccount({
    repository, keychain, client: { authenticate: async () => ({ newEndpoint: null }),
      syncCollection: async () => ({ required: 'NO_CHANGES', stamps: {} }) },
    profileId: profile.id, legacyProfileId: profile.id,
  });

  assert.equal((await account.settings()).loggedIn, true);
  assert.deepEqual(keychain.writes, [
    ['set', `${PASSWORD_ACCOUNT}:${profile.id}`, 'legacy-secret'], ['delete', PASSWORD_ACCOUNT],
  ]);
  await account.logout();
  assert.equal((await account.settings()).loggedIn, false);
  assert.equal(calls.length, 0);
});
