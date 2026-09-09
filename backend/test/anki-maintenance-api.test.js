const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./server-process');

test('collection maintenance API checks, backs up, and persists automatic backup settings', { timeout: 10000 }, async t => {
  const { port, stop } = await startServer();
  t.after(() => stop());
  const request = async (route, body, headers = {}, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json() };
  };

  assert.deepEqual(await request('anki/maintenance/backups'), {
    status: 200,
    payload: { ok: true, backups: { daily: 7, weekly: 4, monthly: 12, minimumIntervalMins: 30 } },
  });
  assert.deepEqual((await request('anki/maintenance/backups', { daily: 10 }, {}, 'PUT')).payload.backups,
    { daily: 10, weekly: 4, monthly: 12, minimumIntervalMins: 30 });
  const saved = await request('anki/maintenance/backups', {
    daily: 10, weekly: 8, monthly: 24, minimumIntervalMins: 45,
  }, {}, 'PUT');
  assert.deepEqual(saved.payload.backups, { daily: 10, weekly: 8, monthly: 24, minimumIntervalMins: 45 });
  assert.equal((await request('anki/maintenance/backups', {
    daily: 10, weekly: 8, monthly: 24, minimumIntervalMins: 45,
  }, { Origin: 'https://untrusted.example' }, 'PUT')).status, 403);
  assert.equal((await request('anki/maintenance/database', undefined, {
    Origin: 'https://untrusted.example',
  }, 'POST')).status, 403);
  assert.deepEqual((await request('anki/maintenance/database', undefined, {}, 'POST')).payload.check, {
    backupCreated: true, healthy: true, report: 'Database rebuilt.',
  });
  assert.deepEqual((await request('anki/maintenance/media', undefined, {}, 'POST')).payload.check, {
    missing: [], unused: [], report: 'No media issues found.', haveTrash: false,
  });
  assert.deepEqual((await request('anki/maintenance/backup', undefined, {}, 'POST')).payload.backup,
    { created: true });
});
