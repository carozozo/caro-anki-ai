const test = require('node:test');
const assert = require('node:assert/strict');
const { AnkiMaintenance } = require('../anki-maintenance');

const backupSettings = { daily: 7, weekly: 4, monthly: 12, minimumIntervalMins: 30 };

test('reads and updates native backup settings with bounded integer values', async () => {
  const calls = [];
  const client = {
    invoke: async (action, params) => {
      calls.push({ action, params });
      return action === 'backupSettings' ? backupSettings : params;
    },
  };
  const maintenance = new AnkiMaintenance({ client });

  assert.deepEqual(await maintenance.backups(), backupSettings);
  assert.deepEqual(await maintenance.updateBackups({ daily: 14 }), {
    daily: 14, weekly: 4, monthly: 12, minimumIntervalMins: 30,
  });
  assert.deepEqual(calls.at(-1), {
    action: 'updateBackupSettings',
    params: { daily: 14, weekly: 4, monthly: 12, minimumIntervalMins: 30 },
  });
  await assert.rejects(maintenance.updateBackups({ daily: -1 }), { statusCode: 400 });
  await assert.rejects(maintenance.updateBackups({ weekly: 1.5 }), { statusCode: 400 });
});

test('creates a backup before checking the database and passes media results through', async () => {
  const calls = [];
  const client = {
    invoke: async action => {
      calls.push(action);
      if (action === 'createBackup') return { created: true };
      if (action === 'checkDatabase') return { healthy: true, report: 'Database rebuilt.' };
      return { missing: ['gone.mp3'], unused: ['old.mp3'], report: 'Media report', haveTrash: true };
    },
  };
  const maintenance = new AnkiMaintenance({ client });

  assert.deepEqual(await maintenance.checkDatabase(), {
    backupCreated: true, healthy: true, report: 'Database rebuilt.',
  });
  assert.deepEqual(calls, ['createBackup', 'checkDatabase']);
  assert.deepEqual(await maintenance.checkMedia(), {
    missing: ['gone.mp3'], unused: ['old.mp3'], report: 'Media report', haveTrash: true,
  });
});
