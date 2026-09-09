const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer } = require('./server-process');

test('the profile API renames a managed collection only after the explicit route is called',
  { timeout: 10000 }, async t => {
  let profileRoot;
  const { port, stop } = await startServer(({ tempDir }) => {
    profileRoot = path.join(tempDir, 'profiles');
    const source = path.join(profileRoot, 'User 1');
    fs.mkdirSync(path.join(source, 'collection.media'), { recursive: true });
    fs.writeFileSync(path.join(source, 'collection.anki2'), 'fixture collection');
    fs.writeFileSync(path.join(source, 'collection.media', 'sample.mp3'), 'media');
    return { ANKI_PROFILE_ROOT: profileRoot };
  });
  t.after(() => stop());
  const request = async (url, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json() };
  };

  const listed = await request('/api/profiles');
  assert.equal(listed.status, 200);
  assert.equal(listed.payload.profiles.length, 1);
  assert.equal(listed.payload.profiles[0].name, 'User 1');
  assert.equal(listed.payload.profiles[0].canRename, true);
  const id = listed.payload.activeProfileId;
  assert.equal((await request(`/api/profiles/${id}/rename`, { name: 'Caro' },
    { Origin: 'https://untrusted.example' })).status, 403);
  const renamed = await request(`/api/profiles/${id}/rename`, { name: 'Caro' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.payload.profile.name, 'Caro');
  assert.equal(renamed.payload.reloadRequired, true);
  assert.equal(fs.existsSync(path.join(profileRoot, 'User 1')), false);
  assert.equal(fs.readFileSync(path.join(profileRoot, 'Caro', 'collection.anki2'), 'utf8'), 'fixture collection');
  assert.equal(fs.readFileSync(path.join(profileRoot, 'Caro', 'collection.media', 'sample.mp3'), 'utf8'), 'media');
});

test('creates, activates, and isolates collection profiles', { timeout: 10000 }, async t => {
  let profileRoot;
  const { port, stop } = await startServer(({ tempDir }) => {
    profileRoot = path.join(tempDir, 'profiles');
    const source = path.join(profileRoot, 'Caro');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'collection.anki2'), 'fixture collection');
    return { ANKI_PROFILE_ROOT: profileRoot };
  });
  t.after(() => stop());
  const request = async (url, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json() };
  };

  const before = await request('/api/profiles');
  const carolId = before.payload.activeProfileId;
  const session = await request('/api/sessions', { method: 'POST', body: { title: 'Caro work' } });
  await request('/api/anki-settings', {
    method: 'PUT', body: { modelName: 'Basic', allowDuplicate: false, visibleDecks: [] },
  });
  const created = await request('/api/profiles', { method: 'POST', body: { name: 'Reading' } });

  assert.equal(created.status, 201);
  assert.equal(created.payload.profile.active, false);
  assert.equal(fs.existsSync(path.join(profileRoot, 'Reading', 'collection.anki2')), true);
  const readingId = created.payload.profile.id;
  const activated = await request(`/api/profiles/${readingId}/activate`, { method: 'POST', body: {} });
  assert.equal(activated.status, 200);
  assert.equal(activated.payload.reloadRequired, true);
  assert.equal((await request('/api/sessions')).payload.sessions.length, 0);
  assert.equal((await request(`/api/sessions/${session.payload.session.id}`)).status, 404);
  assert.equal((await request('/api/anki-settings')).payload.modelName, 'English');

  await request(`/api/profiles/${carolId}/activate`, { method: 'POST', body: {} });
  assert.equal((await request('/api/sessions')).payload.sessions[0].id, session.payload.session.id);
  const carolSettings = await request('/api/anki-settings');
  assert.equal(carolSettings.payload.modelName, 'Basic');
  assert.equal(carolSettings.payload.allowDuplicate, false);
});

test('deletes an inactive collection profile through the explicit route', { timeout: 10000 }, async t => {
  let profileRoot;
  const { port, stop } = await startServer(({ tempDir }) => {
    profileRoot = path.join(tempDir, 'profiles');
    const source = path.join(profileRoot, 'Caro');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'collection.anki2'), 'fixture collection');
    return { ANKI_PROFILE_ROOT: profileRoot };
  });
  t.after(() => stop());
  const request = async (url, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json() };
  };

  const before = await request('/api/profiles');
  const carolId = before.payload.activeProfileId;
  const created = await request('/api/profiles', { method: 'POST', body: { name: 'Reading' } });
  const readingId = created.payload.profile.id;

  const crossOrigin = await request(`/api/profiles/${readingId}`, { method: 'DELETE',
    headers: { Origin: 'https://untrusted.example' } });
  assert.equal(crossOrigin.status, 403);
  const active = await request(`/api/profiles/${carolId}`, { method: 'DELETE' });
  assert.equal(active.status, 409);
  assert.equal(active.payload.code, 'profile_active');
  assert.equal(fs.existsSync(path.join(profileRoot, 'Reading', 'collection.anki2')), true);

  const removed = await request(`/api/profiles/${readingId}`, { method: 'DELETE' });

  assert.equal(removed.status, 200);
  assert.equal(removed.payload.removed, 'Reading');
  assert.equal(removed.payload.activeProfileId, carolId);
  assert.deepEqual(removed.payload.profiles.map(profile => profile.name), ['Caro']);
  assert.equal(fs.existsSync(path.join(profileRoot, 'Reading')), false);
  assert.equal(fs.readFileSync(path.join(profileRoot, 'Caro', 'collection.anki2'), 'utf8'), 'fixture collection');
  const [backup] = fs.readdirSync(path.join(profileRoot, 'profile-backups', readingId));
  assert.equal(fs.readFileSync(path.join(profileRoot, 'profile-backups', readingId, backup, 'collection.anki2'),
    'utf8'), 'fixture collection');
});
