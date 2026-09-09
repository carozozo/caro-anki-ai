const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createDatabase } = require('../../sqlite/database');
const Repository = require('../../sqlite/repository');
const { KeychainStore, execWithTimeout } = require('../keychain-store');
const { AgentManager } = require('../agent-manager');

const setup = () => {
  const db = createDatabase({ dbPath: ':memory:', migrationsDir: path.resolve(__dirname, '../../sqlite/migrations') });
  const repository = new Repository(db);
  const secrets = new Map();
  const keychain = { get: async id => secrets.get(id) || null, set: async (id, key) => secrets.set(id, key),
    delete: async id => secrets.delete(id) };
  const manager = new AgentManager({ repository, keychain, browser: {}, client: {}, ankiConfig: {} });
  return { db, repository, secrets, manager };
};

test('stores multiple agent profiles without putting API keys in SQLite', async t => {
  const { db, repository, secrets, manager } = setup();
  t.after(() => db.close());
  const first = await manager.create({ name: 'Daily', model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com', reasoningEffort: 'low', apiKey: 'secret-1' });
  const second = await manager.create({ name: 'Reasoning', model: 'deepseek-reasoner',
    baseUrl: 'https://api.deepseek.com', reasoningEffort: 'high', apiKey: 'secret-2' });

  repository.updateAgentSettings({ enabled: true, activeProfileId: second.id });
  const settings = await manager.settings();
  assert.equal(settings.enabled, true);
  assert.equal(settings.activeProfileId, second.id);
  assert.deepEqual(settings.profiles.map(profile => profile.name), ['Daily', 'Reasoning']);
  assert.equal(secrets.get(first.id), 'secret-1');
  assert.equal(JSON.stringify(repository.listAgentProfiles()).includes('secret-1'), false);

  await manager.delete(second.id);
  assert.equal((await manager.settings()).activeProfileId, first.id);
  assert.equal(secrets.has(second.id), false);
});

test('rejects incomplete agent profiles before storing them', async t => {
  const { db, repository, manager } = setup();
  t.after(() => db.close());
  const input = { name: 'Daily', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' };

  await assert.rejects(manager.create(input), /apiKey is required/);
  assert.deepEqual(repository.listAgentProfiles(), []);

  const profile = repository.createAgentProfile({ ...input, provider: 'deepseek', reasoningEffort: 'high' });
  await assert.rejects(manager.update(profile.id, { name: 'Updated' }), /apiKey is required/);
  assert.equal(repository.getAgentProfile(profile.id).name, 'Daily');
});

test('rejects duplicate agent profile names on create and update', async t => {
  const { db, repository, manager } = setup();
  t.after(() => db.close());
  const base = { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKey: 'secret' };
  const first = await manager.create({ ...base, name: 'Daily' });

  await assert.rejects(manager.create({ ...base, name: '  Daily  ' }), error => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /name already exists/);
    return true;
  });

  const second = await manager.create({ ...base, name: 'Reasoning' });
  await assert.rejects(manager.update(second.id, { name: first.name }), { statusCode: 409 });
  assert.deepEqual(repository.listAgentProfiles().map(profile => profile.name), ['Daily', 'Reasoning']);
  assert.equal((await manager.update(first.id, { name: first.name })).name, 'Daily');
});

test('accepts an auto reasoning effort and hands it to the provider unresolved', async t => {
  const { db, repository, manager } = setup();
  t.after(() => db.close());
  const auto = await manager.create({ name: 'Auto', model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com', reasoningEffort: 'auto', apiKey: 'secret' });
  assert.equal(auto.reasoningEffort, 'auto');
  assert.equal(repository.getAgentProfile(auto.id).reasoningEffort, 'auto');
  await assert.rejects(manager.create({ name: 'Legacy alias', model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com', reasoningEffort: 'medium', apiKey: 'secret' }),
  /Invalid reasoning effort/);
});

test('rolls back profile metadata when Keychain storage fails', async t => {
  const { db, repository } = setup();
  t.after(() => db.close());
  const manager = new AgentManager({ repository, keychain: { set: async () => { throw new Error('Keychain failed'); } },
    browser: {}, client: {}, ankiConfig: {} });

  await assert.rejects(manager.create({ name: 'Daily', model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com', apiKey: 'secret' }), /Keychain failed/);
  assert.deepEqual(repository.listAgentProfiles(), []);
});

test('requires a saved profile even when the process environment has an API key', async t => {
  const { db, repository } = setup();
  t.after(() => db.close());
  const manager = new AgentManager({ repository, keychain: { get: async () => null }, browser: {}, client: {},
    ankiConfig: {} });
  const settings = await manager.settings();
  assert.equal(settings.enabled, false);
  assert.deepEqual(settings.profiles, []);
  repository.updateAgentSettings({ enabled: true });
  assert.equal((await manager.settings()).enabled, true);
  await assert.rejects(manager.getAgent(), /Select an Anki Agent configuration/);
});

test('keychain store passes secrets as process arguments and handles missing entries', async () => {
  const calls = [];
  const store = new KeychainStore({ runner: async (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'find-generic-password') return { stdout: 'saved-key\n' };
    return { stdout: '' };
  } });
  await store.set('profile-1', 'secret');
  assert.equal(await store.get('profile-1'), 'saved-key');
  await store.delete('profile-1');
  assert.deepEqual(calls.map(call => call.args[0]),
    ['add-generic-password', 'find-generic-password', 'delete-generic-password']);
});

// A Keychain that is locked or waiting on a prompt blocks `security` forever, and nothing above it has a
// deadline, so the call itself has one and reports it as a failure rather than as an empty secret.
test('a Keychain call that never answers fails on its own deadline', async () => {
  await assert.rejects(
    execWithTimeout({ timeoutMs: 200 })(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']),
    /timed out after 200ms/,
  );
});
