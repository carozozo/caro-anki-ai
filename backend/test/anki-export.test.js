const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createDatabase } = require('../../sqlite/database');
const Repository = require('../../sqlite/repository');
const { AnkiExport } = require('../anki-export');
const { englishProfile, profileLibrary } = require('./helpers/profile-fixture');

// An export is built out of the profile that describes the collection's note type, so a test supplies one the
// same way the server does. A name no profile describes is the state that user is in.
const profilesOf = noteType => profileLibrary(noteType ? { [noteType]: englishProfile } : {});

const card = {
  term: 'thickness', meaning: 'the quality of being thick', type: 'noun', typeLabel: 'U',
  translation: '厚度', implications: ['測量', '材質', '厚度'], phonetic: '/ˈθɪknəs/',
  examples: Array.from({ length: 3 }, () => ({ en: 'Check the thickness.', zh: '檢查厚度。' })),
};
const setup = (t, addNotes = async () => [123], cardProfiles = profilesOf('English')) => {
  const db = createDatabase({ dbPath: ':memory:', migrationsDir: path.resolve(__dirname, '../../sqlite/migrations') });
  t.after(() => db.close());
  const repository = new Repository(db);
  const session = repository.createSession();
  const save = (cards = [card]) => repository.createCardVersion({
    sessionId: session.id, cards, schemaVersion: '1.1', source: 'manual', validationStatus: 'valid',
  });
  const version = save();
  const config = { modelName: 'English', allowDuplicate: true };
  const client = { addNotes, invoke: async action => action === 'currentDeckName' ? '_Todo' : null };
  const service = new AnkiExport({ repository, client, config, cardProfiles });
  const preview = () => service.preview(session.id, version.id);
  const add = exportId => service.add(session.id, { exportId, confirmed: true });
  return { repository, session, version, service, config, save, preview, add };
};

test('preview snapshots fields in Anki\'s current deck', async t => {
  const { preview, repository, session } = setup(t, () => assert.fail('unexpected Anki write'));
  const result = await preview();
  assert.equal(result.status, 'preview');
  assert.equal(result.notes[0].deckName, '_Todo');
  assert.equal(result.notes[0].fields['詞彙'], 'thickness');
  assert.deepEqual(result.notes[0].tags, []);
  assert.equal(repository.listAnkiExports(session.id).length, 1);
});

test('preview accepts a selected deck', async t => {
  const { service, session, version } = setup(t);
  assert.equal((await service.preview(session.id, version.id, 0, 'Verb')).notes[0].deckName, 'Verb');
  await assert.rejects(service.preview(session.id, version.id, 0, '  '), { statusCode: 400 });
});

test('requires confirmation and preserves a preview after newer versions are saved', async t => {
  const { preview, service, session, repository, save, add } = setup(t);
  const { id } = await preview();
  await assert.rejects(service.add(session.id, { exportId: id }), { statusCode: 400 });
  await assert.rejects(service.add(session.id, { exportId: '1', confirmed: true }), { statusCode: 400 });
  const other = repository.createSession();
  await assert.rejects(service.add(other.id, { exportId: id, confirmed: true }), { statusCode: 404 });
  save();
  assert.deepEqual((await add(id)).noteIds, [123]);
});

test('previews a selected historical version', async t => {
  const { service, session, save } = setup(t);
  const older = await service.preview(session.id, 1);
  const newer = save([{ ...card, term: 'newer' }]);
  const historical = await service.preview(session.id, 1);
  assert.equal(newer.version_number, 2);
  assert.equal(older.notes[0].fields['詞彙'], 'thickness');
  assert.equal(historical.notes[0].fields['詞彙'], 'thickness');
});

test('revalidates old versions even when marked valid', async t => {
  const { service, session, save } = setup(t);
  const invalid = save([{ ...card, examples: ['legacy'] }]);
  await assert.rejects(service.preview(session.id, invalid.id), { statusCode: 422 });
});

// Nothing in the app knows what a card of an undescribed note type holds, so there is no note to build and
// the one useful answer is the profile that would make one buildable.
test('refuses to export a note type no profile describes', async t => {
  const { service, session } = setup(t, undefined, profilesOf());
  await assert.rejects(service.preview(session.id, 1), error => {
    assert.equal(error.statusCode, 503);
    assert.match(error.message, /No card profile is configured for the English note type/);
    return true;
  });
});

test('allows separately previewed cards from the same version to be submitted', async t => {
  let calls = 0;
  const { preview, add } = setup(t, async notes => { calls++; assert.equal(notes.length, 1); return [123]; });
  const first = await preview();
  const second = await preview();
  assert.deepEqual((await add(first.id)).noteIds, [123]);
  assert.equal((await add(first.id)).status, 'completed');
  assert.deepEqual((await add(second.id)).noteIds, [123]);
  assert.equal(calls, 2);
});

test('claims each preview before awaiting Anki and blocks repeated confirmations', async t => {
  let release;
  const { preview, add } = setup(t, () => new Promise(resolve => { release = resolve; }));
  const first = await preview();
  const pending = add(first.id);
  await assert.rejects(add(first.id), { statusCode: 409 });
  release([123]);
  assert.equal((await pending).status, 'completed');
});

test('retains partial note IDs and never automatically resubmits failed exports', async t => {
  const { service, session, save, add } = setup(t, async () => [123, null]);
  const version = save([card, card]);
  const preview = await service.preview(session.id, version.id);
  const result = await add(preview.id);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.noteIds, [123, null]);
  await assert.rejects(add(preview.id), { statusCode: 409 });
});

test('persists unknown outcomes after transport failure', async t => {
  const { preview, add, repository, session } = setup(t, async () => { throw new Error('timeout'); });
  const result = await add((await preview()).id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.outcomeUnknown, true);
  assert.match(repository.listAnkiExports(session.id)[0].error_json, /timeout/);
});
