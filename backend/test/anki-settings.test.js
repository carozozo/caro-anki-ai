const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createDatabase } = require('../../sqlite/database');
const Repository = require('../../sqlite/repository');
const { AnkiSettings } = require('../anki-settings');

const setup = t => {
  const db = createDatabase({ dbPath: ':memory:', migrationsDir: path.resolve(__dirname, '../../sqlite/migrations') });
  t.after(() => db.close());
  const repository = new Repository(db);
  const config = {};
  return { db, repository, config, manager: new AnkiSettings({ repository, config }) };
};

test('persists standalone collection defaults and applies them immediately', async t => {
  const { db, repository, config, manager } = setup(t);
  assert.deepEqual(manager.settings(), { modelName: 'English', allowDuplicate: true, visibleDecks: [] });

  const settings = await manager.update({
    modelName: 'Basic', allowDuplicate: false, visibleDecks: ['_Todo', 'Default', '_Todo'],
  });

  assert.deepEqual(settings, { modelName: 'Basic', allowDuplicate: false, visibleDecks: ['_Todo', 'Default'] });
  assert.deepEqual(config, settings);
  assert.deepEqual(repository.getAnkiSettings(), settings);
  assert.deepEqual(
    db.prepare("SELECT name FROM pragma_table_info('anki_settings') ORDER BY cid").all().map(row => row.name),
    ['id', 'model_name', 'allow_duplicate', 'updated_at', 'sync_username', 'sync_endpoint', 'sync_media',
      'visible_decks_json'],
  );
});

// The deck list is the browser's whitelist and an empty one means every deck, so a partial update must
// never clear it by accident — that would silently switch the user back to the full collection.
test('keeps the stored deck list when an update omits it', async t => {
  const { manager } = setup(t);
  await manager.update({ modelName: 'English', allowDuplicate: true, visibleDecks: ['_Todo'] });
  const settings = await manager.update({ modelName: 'Basic' });
  assert.equal(settings.modelName, 'Basic');
  assert.deepEqual(settings.visibleDecks, ['_Todo']);
});

test('keeps the visible deck whitelist aligned with deck renames and removals', async t => {
  const { manager } = setup(t);
  await manager.update({
    modelName: 'English', allowDuplicate: true,
    visibleDecks: ['Study', 'Study::Words', 'Other'],
  });

  await manager.renameVisibleDecks('Study', 'Review');
  assert.deepEqual(manager.settings().visibleDecks, ['Review', 'Review::Words', 'Other']);

  await manager.removeVisibleDecks('Review');
  assert.deepEqual(manager.settings().visibleDecks, ['Other']);
});

test('validates the local note type, duplicate setting, and deck list', async t => {
  const { manager } = setup(t);
  await assert.rejects(manager.update({ modelName: '' }), { statusCode: 400 });
  await assert.rejects(manager.update({ allowDuplicate: 'false' }), { statusCode: 400 });
  await assert.rejects(manager.update({ visibleDecks: 'Default' }), { statusCode: 400 });
});

test('keeps card defaults independent for each collection profile', async t => {
  const { repository } = setup(t);
  const first = repository.ensureAnkiProfile({
    name: 'Caro', collectionPath: '/profiles/Caro/collection.anki2',
  }).profile;
  repository.ensureAnkiProfileSettings(first.id);
  repository.beginAnkiProfileCreation({
    id: 'reading', name: 'Reading', collectionPath: '/profiles/Reading/collection.anki2',
    stagingPath: '/profiles/profile-staging/reading',
  });
  const second = repository.finishAnkiProfileCreation('reading');
  const firstManager = new AnkiSettings({ repository, config: {}, profileId: first.id });
  const secondManager = new AnkiSettings({ repository, config: {}, profileId: second.id });

  await firstManager.update({ modelName: 'Basic', allowDuplicate: false, visibleDecks: ['Default'] });

  assert.equal(firstManager.settings().modelName, 'Basic');
  assert.deepEqual(secondManager.settings(), { modelName: 'English', allowDuplicate: true, visibleDecks: [] });
});
