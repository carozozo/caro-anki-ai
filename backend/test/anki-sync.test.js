const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { startServer: startTestServer } = require('./server-process');
const {
  AnkiLocal, ankiRuntimeProblem, parseBridgeOutput, parseProgressLine, runBridge, syncPerformed,
  syncRequired,
} = require('../anki-local');

const bridgePath = path.resolve(__dirname, 'fixtures/anki-bridge.js');
const noisyBridgePath = path.resolve(__dirname, 'fixtures/noisy-bridge.js');
const noisyErrorBridgePath = path.resolve(__dirname, 'fixtures/noisy-error-bridge.js');
const silentBridgePath = path.resolve(__dirname, 'fixtures/silent-bridge.js');
const stalledBridgePath = path.resolve(__dirname, 'fixtures/stalled-bridge.js');
const slowProgressBridgePath = path.resolve(__dirname, 'fixtures/slow-progress-bridge.js');

const runFixture = (bridge, logger, overrides = {}) => runBridge({
  pythonPath: process.execPath,
  bridgePath: bridge,
  collectionPath: '/tmp/collection.anki2',
  timeoutMs: 5000,
  request: { action: 'deckNames', params: {} },
  logger,
  ...overrides,
});

// The runner form replaces the spawned bridge, but the runtime is still validated first, so every path
// has to point at something that exists.
const clientWith = (runner, overrides = {}) => new AnkiLocal({
  collectionPath: '/tmp/collection.anki2',
  pythonPath: process.execPath,
  bridgePath,
  timeoutMs: 5000,
  runner,
  ...overrides,
});

// Replacing the runner skips the bridge process, but the bridge is exactly what pushes progress, so a test
// that needs the push spawns the fixture instead.
const spawnedClient = (overrides = {}) => new AnkiLocal({
  collectionPath: '/tmp/collection.anki2',
  pythonPath: process.execPath,
  bridgePath,
  timeoutMs: 5000,
  ...overrides,
});

test('an exclusive collection operation rejects new work and can retarget an idle client', async () => {
  const calls = [];
  const client = clientWith(async input => { calls.push(input.collectionPath); return ['Default']; });
  client.beginExclusive();
  await assert.rejects(client.invoke('deckNames', {}), { code: 'collection_busy' });
  client.endExclusive();
  client.setCollectionPath('/tmp/Caro/collection.anki2');
  await client.invoke('deckNames', {});
  assert.deepEqual(calls, ['/tmp/Caro/collection.anki2']);
});

test('parseBridgeOutput reads the marked result line past Anki stdout noise', () => {
  const stdout = 'blocked main thread for 1305ms:\n  File "anki_bridge.py", line 200\n'
    + '__ANKI_BRIDGE_RESULT__{"result":{"required":"NORMAL_SYNC"},"error":null}\n';
  assert.deepEqual(parseBridgeOutput(stdout), { result: { required: 'NORMAL_SYNC' }, error: null });
  assert.equal(parseBridgeOutput('blocked main thread for 1305ms:\n'), null);
  assert.equal(parseBridgeOutput(''), null);
});

test('parseBridgeOutput takes the last marked line so an earlier line cannot win', () => {
  const stdout = '__ANKI_BRIDGE_RESULT__{"result":1,"error":null}\n'
    + 'blocked main thread for 2000ms:\n'
    + '__ANKI_BRIDGE_RESULT__{"result":2,"error":null}\n';
  assert.deepEqual(parseBridgeOutput(stdout), { result: 2, error: null });
});

// Anki names the stage of a normal sync and formats its own counts, and those names live in its Rust
// binary rather than any file this repo can read, so every stage is passed through: none is translated,
// and none is dropped for being unrecognised.
test("parseProgressLine passes Anki's stage and counts through as it reported them", () => {
  assert.deepEqual(parseProgressLine(
    '__ANKI_BRIDGE_PROGRESS__{"kind":"normal_sync","stage":"Syncing","added":"2 cards","removed":"1 note"}'),
  { kind: 'normal_sync', stage: 'Syncing', added: '2 cards', removed: '1 note' });
  assert.deepEqual(parseProgressLine(
    '__ANKI_BRIDGE_PROGRESS__{"kind":"normal_sync","stage":"Finalizing","added":null,"removed":null}'),
  { kind: 'normal_sync', stage: 'Finalizing', added: null, removed: null });
  // A stage this app has never seen is still Anki's own word for what it is doing.
  assert.equal(parseProgressLine(
    '__ANKI_BRIDGE_PROGRESS__{"kind":"normal_sync","stage":"Checking media","added":""}').stage,
  'Checking media');
});

test('parseProgressLine reads a full-sync transfer, and only when Anki reported bytes', () => {
  assert.deepEqual(parseProgressLine(
    '__ANKI_BRIDGE_PROGRESS__{"kind":"full_sync","transferred":4096,"total":8192}'),
  { kind: 'full_sync', transferred: 4096, total: 8192 });
  // A merge sends change chunks and has no size, so a missing one is not a zero.
  assert.equal(parseProgressLine('__ANKI_BRIDGE_PROGRESS__{"kind":"full_sync","total":8192}'), null);
});

test('parseProgressLine keeps media counts as the strings Anki formatted', () => {
  assert.deepEqual(parseProgressLine(
    '__ANKI_BRIDGE_PROGRESS__{"kind":"media_sync","media":{"checked":"42","added":"3","removed":"0"}}'),
  { kind: 'media_sync', media: { checked: '42', added: '3', removed: '0' } });
  assert.equal(parseProgressLine('__ANKI_BRIDGE_PROGRESS__{"kind":"media_sync"}'), null);
});

test('parseProgressLine drops a kind this app does not draw and any line that is not progress', () => {
  // Anki reports importing and exporting progress too; nothing here draws it, and a guessed shape would be
  // worse than no update, so an unknown kind is dropped and an unreadable line is never fatal.
  assert.equal(parseProgressLine('__ANKI_BRIDGE_PROGRESS__{"kind":"importing","total":10}'), null);
  assert.equal(parseProgressLine('__ANKI_BRIDGE_RESULT__{"result":{},"error":null}'), null);
  assert.equal(parseProgressLine('__ANKI_BRIDGE_PROGRESS__not json'), null);
  assert.equal(parseProgressLine('blocked main thread for 1305ms:'), null);
  assert.equal(parseProgressLine(''), null);
});

test('runBridge resolves the marked result from a noisy bridge', async () => {
  assert.deepEqual(await runFixture(noisyBridgePath), { required: 'NORMAL_SYNC' });
});

test('runBridge surfaces a marked bridge error even with stdout noise', async () => {
  await assert.rejects(runFixture(noisyErrorBridgePath), /Anki: auth failed/);
});

test('runBridge reports an invalid response when no marked line is present', async () => {
  await assert.rejects(runFixture(silentBridgePath), /Invalid Anki bridge response/);
});

test('runBridge logs the raw output when no marked line is present', async () => {
  const events = [];
  await assert.rejects(runFixture(silentBridgePath, event => events.push(event)),
    /Invalid Anki bridge response/);
  assert.equal(events.length, 1);
  assert.equal(events[0].message, 'Invalid Anki bridge response');
  assert.equal(events[0].code, 0);
  assert.equal(events[0].stdout, '');
});

test('runBridge logs a marked bridge error together with the stdout noise', async () => {
  const events = [];
  await assert.rejects(runFixture(noisyErrorBridgePath, event => events.push(event)), /Anki: auth failed/);
  assert.equal(events.length, 1);
  assert.equal(events[0].message, 'bridge error: auth failed');
  assert.match(events[0].stdout, /blocked main thread for 2400ms/);
});

// A killed bridge reports no exit code, so the deadline is the only thing that can name this failure.
test('runBridge reports its own deadline when the bridge never answers', async () => {
  const events = [];
  await assert.rejects(
    runFixture(stalledBridgePath, event => events.push(event), { timeoutMs: 200 }),
    /Anki bridge timed out after 200ms/,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].message, 'Anki bridge timed out after 200ms');
});

// Every bridge these tests spawn is this fixture, so it has to end when its stdin does: a child that outlives
// its input keeps the runner alive, and `npm test` then never returns.
test('the fixture bridge exits when its stdin ends', async () => {
  const child = spawn(process.execPath, [bridgePath], { stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end();
  assert.deepEqual(await once(child, 'exit'), [0, null]);
});

// A bridge that goes quiet used to be killed with the request left pending, which blocked that request and
// every call queued behind it. The deadline now ends the request itself, and the dead bridge is dropped.
test('a stalled bridge answers with its deadline and leaves the queue usable', async t => {
  const events = [];
  const client = spawnedClient({
    bridgePath: stalledBridgePath, timeoutMs: 200, logger: event => events.push(event),
  });
  t.after(() => client.close());

  await assert.rejects(client.invoke('deckNames', {}), /Anki bridge timed out after 200ms/);
  assert.equal(client.bridge.child, null);
  // The second call proves the queue is not stuck on the first one: it expires on its own deadline too.
  await assert.rejects(client.invoke('deckNames', {}), /Anki bridge timed out after 200ms/);
  assert.deepEqual(events.map(event => event.message),
    ['Anki bridge timed out after 200ms', 'Anki bridge timed out after 200ms']);
});

// A sync reports while it runs, so the deadline measures silence rather than the length of the work: this
// bridge reports for longer than the deadline and still answers.
test('a progress report pushes the deadline out, so a long sync is not killed for being long', async t => {
  const updates = [];
  const client = spawnedClient({ bridgePath: slowProgressBridgePath, timeoutMs: 1000 });
  t.after(() => client.close());

  const result = await client.syncCollection({
    username: 'user@example.com', password: 'secret', onProgress: update => updates.push(update),
  });

  assert.equal(updates.length, 15);
  assert.equal(result.required, 'NO_CHANGES');
});

test('an installed helper is the runtime, and a missing one is a setup error', () => {
  const runtime = {
    helperPath: '/nonexistent/anki-helper', bundledHelperPath: '/nonexistent/bundled',
    pythonPath: 'python3', bridgePath,
  };
  assert.match(ankiRuntimeProblem(runtime), /Bundled Anki runtime is missing at \/nonexistent\/anki-helper/);
  assert.equal(ankiRuntimeProblem({ ...runtime, helperPath: process.execPath }), null);
});

test('without a helper the script runtime is validated instead', () => {
  const runtime = { helperPath: null, bundledHelperPath: '/nonexistent/bundled', bridgePath };
  assert.equal(ankiRuntimeProblem({ ...runtime, pythonPath: process.execPath }), null);
  assert.match(ankiRuntimeProblem({ ...runtime, pythonPath: '/nonexistent/python3' }),
    /Anki runtime is missing/);
  const overrides = { helperPath: null, bundledHelperPath: '/nonexistent/bundled', pythonPath: 'python3' };
  assert.match(ankiRuntimeProblem({ ...overrides, bridgePath: '/nonexistent/anki_bridge.py' }),
    /Anki bridge script is missing/);
});

test('a missing runtime fails a call with 503 before anything is spawned', async () => {
  const client = clientWith(async () => { throw new Error('the runner must not be reached'); },
    { helperPath: '/nonexistent/anki-helper' });
  await assert.rejects(client.invoke('deckNames', {}), error => {
    assert.equal(error.statusCode, 503);
    assert.match(error.message, /Bundled Anki runtime is missing/);
    return true;
  });
});

test('syncCollection sends the account, media flag, and no full-sync direction by default', async () => {
  const requests = [];
  const client = clientWith(async request => { requests.push(request); return { required: 'NORMAL_SYNC' }; });

  const result = await client.syncCollection({
    username: 'user@example.com', password: 'secret', endpoint: null, media: true,
  });

  assert.deepEqual(result, { required: 'NORMAL_SYNC' });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].request, {
    action: 'sync',
    params: {
      username: 'user@example.com', password: 'secret', endpoint: null, syncMedia: true, fullSync: null,
    },
  });
});

test('syncCollection defaults media and endpoint when they are not configured', async () => {
  const requests = [];
  const client = clientWith(async request => { requests.push(request); return { required: 'NORMAL_SYNC' }; });

  await client.syncCollection({ username: 'user@example.com', password: 'secret' });

  assert.deepEqual(requests[0].request.params,
    { username: 'user@example.com', password: 'secret', endpoint: null, syncMedia: false, fullSync: null });
});

// Progress only exists because a caller asked for it, so a caller that does not ask must keep sending — and
// receiving — exactly what it always did.
test('syncCollection asks the bridge for progress only when a listener is given', async () => {
  const requests = [];
  const client = clientWith(async request => { requests.push(request); return { required: 'NORMAL_SYNC' }; });

  const result = await client.syncCollection({ username: 'user@example.com', password: 'secret' });

  assert.equal('progress' in requests[0].request.params, false);
  assert.equal('progress' in result, false);
});

test('syncCollection hands each pushed stage to the listener and reports the collection\'s own last state',
  async t => {
    const updates = [];
    const client = spawnedClient();
    // The bridge child stays alive for the life of the client, so a test that spawns one has to close it or
    // the test process never exits.
    t.after(() => client.close());

    const result = await client.syncCollection({
      username: 'user@example.com', password: 'secret', onProgress: update => updates.push(update),
    });

    // The fixture pushes the shapes Anki does, in Anki's order, so this covers the whole Node-side chain:
    // bridge line, prefix routing, parsing, and the listener.
    assert.deepEqual(updates, [
      { kind: 'normal_sync', stage: 'Connecting', added: null, removed: null },
      { kind: 'normal_sync', stage: 'Syncing', added: '2 cards', removed: '1 note' },
      { kind: 'normal_sync', stage: 'Finalizing', added: '2 cards', removed: '1 note' },
      { kind: 'media_sync', media: { checked: '3', added: '1', removed: '0' } },
    ]);
    // Nothing was written locally and the server was not ahead, so the sync had nothing to move — and Anki
    // answers NO_CHANGES either way, which is exactly why the stamps are what the caller reads.
    assert.equal(result.required, 'NO_CHANGES');
    assert.equal(syncPerformed(result.stamps), false);
    // Anki starts the media sync on its own thread after this call has already returned, so a media state
    // cannot speak for the collection sync: what the caller reports is the collection's own last state.
    assert.deepEqual(result.progress, updates.at(-2));
  });

test('syncCollection reports a full sync as a transfer, because that is what it reports', async t => {
  const updates = [];
  const client = spawnedClient();
  t.after(() => client.close());

  const result = await client.syncCollection({
    username: 'user@example.com', password: 'secret', direction: 'upload',
    onProgress: update => updates.push(update),
  });

  assert.equal(result.required, 'FULL_UPLOAD');
  assert.deepEqual(updates[0], { kind: 'full_sync', transferred: 0, total: 4096 });
  assert.deepEqual(updates.filter(update => update.kind === 'full_sync').at(-1),
    { kind: 'full_sync', transferred: 4096, total: 4096 });
  // The bytes are the whole of what a full sync can report, so they are what its completion message shows.
  assert.deepEqual(result.progress, { kind: 'full_sync', transferred: 4096, total: 4096 });
});

test('syncCollection forwards a full-sync direction so AnkiWeb can resolve the conflict', async () => {
  const requests = [];
  const client = clientWith(async request => {
    requests.push(request);
    return { required: 'FULL_DOWNLOAD', fullSync: request.request.params.fullSync };
  });

  const download = await client.syncCollection({
    username: 'user@example.com', password: 'secret', direction: 'download',
  });
  const upload = await client.syncCollection({
    username: 'user@example.com', password: 'secret', direction: 'upload',
  });

  assert.equal(download.fullSync, 'download');
  assert.equal(upload.fullSync, 'upload');
  assert.deepEqual(requests.map(item => item.request.params.fullSync), ['download', 'upload']);
});

test('syncCollection rejects an unknown direction before touching the collection', async () => {
  const requests = [];
  const client = clientWith(async request => { requests.push(request); return {}; });

  await assert.rejects(client.syncCollection({ direction: 'merge' }), error => {
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /direction must be upload or download/);
    return true;
  });
  assert.deepEqual(requests, []);
});

test('authenticate validates credentials through the bridge login action', async () => {
  const requests = [];
  const client = clientWith(async request => {
    requests.push(request);
    return { newEndpoint: 'https://sync34.ankiweb.net/' };
  });

  const result = await client.authenticate({ username: 'user@example.com', password: 'secret' });

  assert.deepEqual(result, { newEndpoint: 'https://sync34.ankiweb.net/' });
  assert.deepEqual(requests[0].request,
    { action: 'login', params: { username: 'user@example.com', password: 'secret', endpoint: null } });
});

// The reminder on the sync button comes from the collection's own stamps, so the mapping is the part
// worth pinning down: it mirrors Anki's local check, which never contacts AnkiWeb.
test("syncRequired mirrors Anki's local sync check", () => {
  // Never synced: local content is the only knowable reason to sync, and a fresh collection (whose
  // schema stamp is set at creation) must not ask for a full sync forever.
  assert.equal(syncRequired({ mod: 0, scm: 1789635256717, lastSync: 0 }), 'NO_CHANGES');
  assert.equal(syncRequired({ mod: 1789635261407, scm: 1789635261401, lastSync: 0 }), 'NORMAL_SYNC');
  // Synced: the content and schema stamps are compared with the stamp the sync recorded.
  assert.equal(syncRequired({ mod: 1789635261407, scm: 1789635261401, lastSync: 1789635261407 }), 'NO_CHANGES');
  assert.equal(syncRequired({ mod: 1789635261500, scm: 1789635261401, lastSync: 1789635261407 }), 'NORMAL_SYNC');
  assert.equal(syncRequired({ mod: 1789635261407, scm: 1789635261500, lastSync: 1789635261407 }), 'FULL_SYNC');
  assert.equal(syncRequired({ mod: 1789635261500, scm: 1789635261500, lastSync: 1789635261407 }), 'FULL_SYNC');
});

// Anki answers NO_CHANGES after a merge it has just performed as well as when there was nothing to do, so
// its answer cannot say whether data moved. Finalizing a sync always writes the collection's last-sync
// stamp, so the stamps the bridge takes around the call are what tells the two apart.
test('syncPerformed reads the stamp a sync writes only when it finalizes', () => {
  const before = { mod: 1789635261500, scm: 1789635261401, lastSync: 0 };
  assert.equal(syncPerformed({ before, after: { ...before, lastSync: 1789635261500 } }), true);
  // Nothing to do: Anki never finalizes, so the stamp is where it was.
  assert.equal(syncPerformed({ before, after: { ...before } }), false);
  // The sync records the server's own stamp, so the two are compared for a change rather than for growth.
  assert.equal(syncPerformed({ before: { mod: 100, scm: 10, lastSync: 900 },
    after: { mod: 100, scm: 10, lastSync: 100 } }), true);
  // A bridge that reports no stamps proves nothing, so it claims nothing.
  assert.equal(syncPerformed({}), false);
  assert.equal(syncPerformed(), false);
});

test('syncStamps reads the local halves of Anki\'s sync check without credentials', async () => {
  const requests = [];
  const client = clientWith(async request => {
    requests.push(request);
    return { mod: 200, scm: 100, lastSync: 100 };
  });

  assert.deepEqual(await client.syncStamps(), { mod: 200, scm: 100, lastSync: 100 });
  assert.deepEqual(requests[0].request, { action: 'syncStamps', params: {} });
  assert.equal(syncRequired(await client.syncStamps()), 'NORMAL_SYNC');
});

// The server half is Anki's own call, so the client only has to forward the account and reject an answer
// that is not one of Anki's three states.
test('syncCheck forwards the account to Anki\'s own status call', async () => {
  const requests = [];
  const client = clientWith(async request => {
    requests.push(request);
    return { required: 'FULL_SYNC', newEndpoint: 'https://sync34.ankiweb.net/' };
  });

  assert.deepEqual(await client.syncCheck({
    username: 'user@example.com', password: 'secret', endpoint: 'https://sync.ankiweb.net/',
  }), { required: 'FULL_SYNC', newEndpoint: 'https://sync34.ankiweb.net/' });
  assert.deepEqual(requests[0].request, {
    action: 'syncCheck',
    params: {
      username: 'user@example.com', password: 'secret', endpoint: 'https://sync.ankiweb.net/',
    },
  });
});

test('syncCheck rejects a status Anki does not define', async () => {
  const client = clientWith(async () => ({ required: 'MAYBE_SYNC' }));
  await assert.rejects(client.syncCheck({ username: 'user@example.com', password: 'secret' }),
    /Invalid Anki sync status: MAYBE_SYNC/);
});

// No test ever writes to the real Keychain: the sync service is namespaced per run, which also makes
// sure a sync request can never reach AnkiWeb with the user's credentials.
const isolatedSyncService = () => `com.caro.anki.sync.test.${process.pid}.${Date.now()}`;

async function startServer (extraEnv = {}) {
  const { port, stop } = await startTestServer({
    ANKI_SYNC_KEYCHAIN_SERVICE: isolatedSyncService(), ...extraEnv,
  });
  return {
    port,
    async post (route, body, headers = {}) {
      const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, payload: await response.json() };
    },
    async get (route) {
      const response = await fetch(`http://127.0.0.1:${port}/api/${route}`);
      return { status: response.status, payload: await response.json() };
    },
    stop,
  };
}

// A server that dies before it listens has to say why: an exit code alone leaves a failing test with nothing
// to act on, which is what a whole debugging session on this file once cost.
test('a server that dies while starting reports what it wrote', async () => {
  const failure = await startServer({ PORT: '0' }).then(() => null, error => error);
  assert.match(failure.message, /Server exited with 1/);
  assert.match(failure.message, /Invalid PORT: 0/);
});

// A sync holds the bridge for its whole duration, so the UI cannot ask Anki what it is doing: it reads a
// snapshot the server keeps instead. The poll starts before the request that fills the snapshot, so an idle
// server has to answer rather than fail.
test('GET /api/anki/sync-progress answers an idle snapshot before any sync has run',
  { timeout: 10000 }, async t => {
    const server = await startServer();
    t.after(() => server.stop());

    assert.deepEqual(await server.get('anki/sync-progress'), {
      status: 200,
      payload: { ok: true, progress: { running: false, direction: null, update: null, elapsedMs: 0 } },
    });
  });

test('POST /api/anki/sync refuses cross-origin and non-JSON requests',
  { timeout: 10000 }, async t => {
    const server = await startServer();
    t.after(() => server.stop());

    const crossOrigin = await fetch(`http://127.0.0.1:${server.port}/api/anki/sync`, {
      method: 'POST', headers: { Origin: 'https://untrusted.example' },
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await server.post('anki/sync', {}, { 'Content-Type': 'text/plain' })).status, 415);
  });

test('POST /api/anki/sync requires a logged-in account before it contacts AnkiWeb',
  { timeout: 10000 }, async t => {
    const server = await startServer();
    t.after(() => server.stop());

    const { status, payload } = await server.post('anki/sync');
    assert.equal(status, 401);
    assert.match(payload.error, /Log in to AnkiWeb/);
    assert.equal((await server.post('anki/sync', { direction: 'download' })).status, 401);
  });

test('the account routes refuse unauthenticated writes', { timeout: 10000 }, async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const crossOrigin = await fetch(`http://127.0.0.1:${server.port}/api/anki/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' },
    body: JSON.stringify({ username: 'user@example.com', password: 'secret' }),
  });
  assert.equal(crossOrigin.status, 403);
  const wrongType = await server.post('anki/account/login',
    { username: 'user@example.com', password: 'secret' }, { 'Content-Type': 'text/plain' });
  assert.equal(wrongType.status, 415);
  assert.equal((await server.post('anki/account/login', { username: '', password: '' })).status, 400);
  assert.equal((await server.post('anki/account/login', { username: '', password: 'secret' })).status, 400);
});

// Every branch of the reminder through the API, in the order Anki takes them: nobody to ask, then the
// server's answer, then the collection's own stamps, then a sync that reconciles the two.
test('GET /api/anki/sync-status follows the collection and AnkiWeb',
  { timeout: 15000 }, async t => {
    const server = await startServer({ ANKI_FIXTURE_REMOTE_AHEAD: '1' });
    t.after(() => server.stop());

    // Nothing written and nobody signed in, so there is nothing to report and nobody to ask.
    assert.deepEqual((await server.get('anki/sync-status')).payload,
      { ok: true, required: 'NO_CHANGES', needsSync: false });

    // Signed in while still clean locally: only the server can answer, and it is ahead. This is the case
    // a local-only check can never see (a phone or AnkiWeb editor having written something).
    await server.post('anki/account/login', { username: 'user@example.com', password: 'secret' });
    assert.deepEqual((await server.get('anki/sync-status')).payload,
      { ok: true, required: 'NORMAL_SYNC', needsSync: true });

    // A local write is now answered by the collection's own stamps, without asking AnkiWeb again.
    const created = await server.post('anki/notes',
      { fields: { 詞彙: 'thickness', 意思: 'the state of being thick' } });
    assert.equal(created.status, 201);
    assert.deepEqual((await server.get('anki/sync-status')).payload,
      { ok: true, required: 'NORMAL_SYNC', needsSync: true });

    // The sync uploads the local change and reconciles the server side, so the reminder clears.
    await server.post('anki/sync');
    assert.deepEqual((await server.get('anki/sync-status')).payload,
      { ok: true, required: 'NO_CHANGES', needsSync: false });
  });

// A signed-out account is silent, exactly like Anki Desktop: without a server to compare against, a
// pending sync is not something the reminder can act on, and the account control is what shows the
// signed-out state. Signing in is what brings the reminder back — including for changes made before it.
test('a signed-out account reports nothing until it signs in', { timeout: 15000 }, async t => {
  const server = await startServer({ ANKI_FIXTURE_REMOTE_AHEAD: '1' });
  t.after(() => server.stop());

  const created = await server.post('anki/notes',
    { fields: { 詞彙: 'thickness', 意思: 'the state of being thick' } });
  assert.equal(created.status, 201);
  assert.deepEqual((await server.get('anki/sync-status')).payload,
    { ok: true, required: 'NO_CHANGES', needsSync: false });

  await server.post('anki/account/login', { username: 'user@example.com', password: 'secret' });
  assert.deepEqual((await server.get('anki/sync-status')).payload,
    { ok: true, required: 'NORMAL_SYNC', needsSync: true });

  // Logging out hides it again rather than leaving a stale reminder behind.
  await fetch(`http://127.0.0.1:${server.port}/api/anki/account`, { method: 'DELETE' });
  assert.deepEqual((await server.get('anki/sync-status')).payload,
    { ok: true, required: 'NO_CHANGES', needsSync: false });
});

test('GET /api/anki-sync-status reports a pending sync until the collection is uploaded',
  { timeout: 15000 }, async t => {
    const server = await startServer();
    t.after(() => server.stop());

    assert.deepEqual((await server.get('anki/sync-status')).payload,
      { ok: true, required: 'NO_CHANGES', needsSync: false });

    await server.post('anki/account/login', { username: 'user@example.com', password: 'secret' });
    const created = await server.post('anki/notes',
      { fields: { 詞彙: 'thickness', 意思: 'the state of being thick' } });
    assert.equal(created.status, 201);
    assert.deepEqual((await server.get('anki/sync-status')).payload,
      { ok: true, required: 'NORMAL_SYNC', needsSync: true });

    await server.post('anki/sync');
    assert.deepEqual((await server.get('anki/sync-status')).payload,
      { ok: true, required: 'NO_CHANGES', needsSync: false });
  });

// AnkiWeb answers NO_CHANGES after a merge it has just performed, so its answer cannot say whether a note
// reached the server: the stamps the sync left are what tells "I uploaded something" apart from "there was
// nothing to do". Reading the completion message off `required` is what used to report a real upload as
// "Anki is already up to date".
test('POST /api/anki/sync reports the merge it performed, not the code AnkiWeb answers with',
  { timeout: 15000 }, async t => {
    const server = await startServer();
    t.after(() => server.stop());

    await server.post('anki/account/login', { username: 'user@example.com', password: 'secret' });
    const created = await server.post('anki/notes',
      { fields: { 詞彙: 'thickness', 意思: 'the state of being thick' } });
    assert.equal(created.status, 201);

    const { payload } = await server.post('anki/sync');
    assert.deepEqual(payload.sync, {
      required: 'NO_CHANGES', serverMessage: '', newEndpoint: null, fullSync: null, merged: true,
      // Anki's own words, formatted by Anki: what the merge moved up and down.
      progress: { kind: 'normal_sync', stage: 'Finalizing', added: '2 cards', removed: '1 note' },
    });
    // The stamp the sync wrote is the same one the reminder compares against, so the merge also clears it.
    assert.deepEqual((await server.get('anki/sync-status')).payload,
      { ok: true, required: 'NO_CHANGES', needsSync: false });
  });

// The full round trip: log in, sync in both directions, then log out. It runs against the fixture
// bridge and an isolated Keychain service, so no credential and no collection ever leaves the machine.
test('login, sync, and logout work through the HTTP API', { timeout: 15000 }, async t => {
  const server = await startServer();
  t.after(() => server.stop());

  const login = await server.post('anki/account/login', {
    username: 'user@example.com', password: 'secret', media: false,
  });
  assert.equal(login.status, 200);
  assert.deepEqual(login.payload.account, {
    username: 'user@example.com', endpoint: null, media: false, loggedIn: true,
  });
  assert.equal((await server.get('anki-settings')).payload.account.loggedIn, true);

  const normal = await server.post('anki/sync');
  assert.equal(normal.status, 200);
  assert.deepEqual(normal.payload.sync, {
    required: 'NO_CHANGES', serverMessage: '', newEndpoint: null, fullSync: null, merged: false,
    // The collection's own last state, which is what a completion message reports.
    progress: { kind: 'normal_sync', stage: 'Finalizing', added: '2 cards', removed: '1 note' },
  });

  const download = await server.post('anki/sync', { direction: 'download' });
  assert.equal(download.payload.sync.required, 'FULL_DOWNLOAD');
  assert.equal(download.payload.sync.fullSync, 'download');
  assert.equal((await server.post('anki/sync', { direction: 'merge' })).status, 400);

  const logout = await fetch(`http://127.0.0.1:${server.port}/api/anki/account`, { method: 'DELETE' });
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).account.loggedIn, false);
  assert.equal((await server.post('anki/sync')).status, 401);
});

test('GET /api/anki-settings reports the account and the Anki runtime state',
  { timeout: 10000 }, async t => {
    const server = await startServer();
    t.after(() => server.stop());

    const { status, payload } = await server.get('anki-settings');
    assert.equal(status, 200);
    assert.deepEqual(payload.account, { username: '', endpoint: null, media: true, loggedIn: false });
    assert.deepEqual(payload.runtime, { available: true, bundled: false, error: null });
  });

test('GET /api/anki-settings names a missing bundled runtime', { timeout: 10000 }, async t => {
  const server = await startServer({ ANKI_HELPER_PATH: '/nonexistent/anki-helper' });
  t.after(() => server.stop());

  const { payload } = await server.get('anki-settings');
  assert.equal(payload.runtime.available, false);
  assert.equal(payload.runtime.bundled, true);
  assert.match(payload.runtime.error, /missing at \/nonexistent\/anki-helper/);
});
