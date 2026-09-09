// The module holds one run at a time, so these tests run in order and each one leaves it settled.
const test = require('node:test');
const assert = require('node:assert/strict');
const { begin, end, record, snapshot } = require('../sync-progress');

test('a snapshot taken before any sync says nothing is running', () => {
  assert.deepEqual(snapshot(), { running: false, direction: null, update: null, elapsedMs: 0 });
});

test('a running sync reports the direction it was started with and each update it records', () => {
  begin('upload');
  const started = snapshot();
  assert.equal(started.running, true);
  assert.equal(started.direction, 'upload');
  // Nothing has been reported yet, which is not the same as a sync that reported nothing.
  assert.equal(started.update, null);
  assert.ok(Number.isFinite(started.elapsedMs) && started.elapsedMs >= 0);

  record({ kind: 'normal_sync', stage: 'Connecting', added: null, removed: null });
  assert.deepEqual(snapshot().update, { kind: 'normal_sync', stage: 'Connecting', added: null, removed: null });

  const full = { kind: 'full_sync', transferred: 4096, total: 8192 };
  record(full);
  assert.deepEqual(snapshot().update, full);
});

test('a finished sync keeps its last update and stops counting', () => {
  end();
  const finished = snapshot();
  assert.equal(finished.running, false);
  assert.equal(finished.direction, 'upload');
  assert.deepEqual(finished.update, { kind: 'full_sync', transferred: 4096, total: 8192 });
  // `elapsedMs` is frozen at the end, so a later read reports the duration rather than a growing one.
  assert.equal(snapshot().elapsedMs, finished.elapsedMs);
});

test('an update that arrives after the sync settled is dropped, and never starts a run', () => {
  record({ kind: 'media_sync', media: { checked: '9', added: '0', removed: '0' } });
  const settled = snapshot();
  assert.deepEqual(settled.update, { kind: 'full_sync', transferred: 4096, total: 8192 });
  assert.equal(settled.running, false);
});

test('a new sync replaces whatever the previous run left behind', () => {
  begin('download');
  const restarted = snapshot();
  assert.equal(restarted.running, true);
  assert.equal(restarted.direction, 'download');
  // The previous run's update must not be readable as this run's state.
  assert.equal(restarted.update, null);

  end();
  assert.deepEqual(snapshot(), {
    running: false, direction: 'download', update: null, elapsedMs: snapshot().elapsedMs,
  });
});
