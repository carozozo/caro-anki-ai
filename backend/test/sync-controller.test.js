const test = require('node:test');
const assert = require('node:assert/strict');
const { syncButtonState } = require('../../frontend/scripts/anki/sync-controller');

test('a forced full sync marks the sync button as an error', () => {
  for (const required of ['FULL_SYNC', 'FULL_UPLOAD', 'FULL_DOWNLOAD']) {
    assert.deepEqual(syncButtonState({ needsSync: true, required }), {
      needsSync: true,
      fullSyncRequired: true,
    });
  }
});

test('ordinary pending and clean sync states do not mark the button as an error', () => {
  assert.equal(syncButtonState({ needsSync: true, required: 'NORMAL_SYNC' }).fullSyncRequired, false);
  assert.deepEqual(syncButtonState({ needsSync: false }), {
    needsSync: false,
    fullSyncRequired: false,
  });
});
