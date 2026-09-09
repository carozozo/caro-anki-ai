const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ankiConfig, appConfig } = require('../config');

test('application identity defaults to the production title', () => {
  assert.deepEqual(appConfig({}, {}), { variant: 'production', title: 'Caro Anki' });
});

test('application identity selects the development title explicitly', () => {
  assert.deepEqual(appConfig({}, { CARO_APP_VARIANT: 'dev' }), { variant: 'dev', title: 'Caro Anki Dev' });
  assert.throws(() => appConfig({}, { CARO_APP_VARIANT: 'staging' }), /Invalid CARO_APP_VARIANT: staging/);
});

test('a bundled runtime is used when nothing is configured explicitly', () => {
  const config = ankiConfig({}, {});
  const built = fs.existsSync(config.bundledHelperPath);
  assert.equal(config.helperPath, built ? config.bundledHelperPath : null);
  assert.equal(config.pythonPath, 'python3');
});

test('an explicit helper path always wins and expands a home shortcut', () => {
  const config = ankiConfig({}, { ANKI_HELPER_PATH: '~/Caro/runtime/anki-helper' });
  assert.equal(config.helperPath, path.join(os.homedir(), 'Caro/runtime/anki-helper'));
});

test('an explicitly configured bridge is never replaced by a bundled runtime', () => {
  const config = ankiConfig({}, { ANKI_BRIDGE_PATH: '/opt/anki_bridge.py' });
  assert.equal(config.helperPath, null);
  assert.equal(config.bridgePath, '/opt/anki_bridge.py');
});

// A collection belongs to a profile, and a profile is a database row. Naming one in the environment is how
// a stale value used to point the app at a collection nobody had chosen.
test('a collection path and an interpreter are not configurable', () => {
  const config = ankiConfig(
    { ANKI_COLLECTION_PATH: '~/Caro/User 1/col.anki2', ANKI_PYTHON_PATH: '/env/python' },
    { ANKI_COLLECTION_PATH: '/tmp/col.anki2', ANKI_PYTHON_PATH: '/usr/bin/python3' });

  assert.equal(config.pythonPath, 'python3');
  assert.equal(config.collectionPath,
    path.join(os.homedir(), 'Library/Application Support/Caro Anki/User 1/collection.anki2'));
});

test('.env values are honoured when the environment does not set them', () => {
  const config = ankiConfig({ ANKI_BRIDGE_PATH: '~/Caro/anki_bridge.py' }, {});

  assert.equal(config.bridgePath, path.join(os.homedir(), 'Caro/anki_bridge.py'));
  assert.equal(config.helperPath, null);
});

test('the collection path defaults to the app support folder', () => {
  const config = ankiConfig({}, {});
  assert.equal(config.profileRoot, path.join(os.homedir(), 'Library/Application Support/Caro Anki'));
  assert.equal(config.collectionPath,
    path.join(os.homedir(), 'Library/Application Support/Caro Anki/User 1/collection.anki2'));
  assert.equal(config.bridgePath, path.resolve(__dirname, '../../backend/anki_bridge.py'));
  assert.equal(config.modelName, 'English');
  assert.equal(config.allowDuplicate, true);
});
