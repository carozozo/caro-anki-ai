const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDatabase } = require('../../sqlite/database');
const Repository = require('../../sqlite/repository');

function createTestRepository () {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caro-anki-ai-'));
  const db = createDatabase({
    dbPath: path.join(tempDir, 'test.sqlite'),
    migrationsDir: path.resolve(__dirname, '../../sqlite/migrations'),
  });
  return { db, repository: new Repository(db), tempDir };
}

test('creates sessions and persists messages after migration', t => {
  const { db, repository, tempDir } = createTestRepository();
  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const session = repository.createSession({ title: '  thickness  ' });
  const message = repository.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'Make a card for thickness',
    payload: { term: 'thickness' },
  });

  assert.equal(session.title, 'thickness');
  assert.equal(repository.listSessions().length, 1);
  assert.equal(repository.getSession(session.id).updated_at, message.created_at);
  assert.equal(repository.listMessages(session.id)[0].content, 'Make a card for thickness');
  assert.deepEqual(JSON.parse(repository.listMessages(session.id)[0].payload_json), { term: 'thickness' });
});

test('stores immutable card versions and advances the current pointer', t => {
  const { db, repository, tempDir } = createTestRepository();
  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const session = repository.createSession();
  const first = repository.createCardVersion({
    sessionId: session.id,
    cards: [{ term: 'first' }],
    schemaVersion: '1.0',
    source: 'ai',
    validationStatus: 'invalid',
    validationErrors: ['term is incomplete'],
  });
  const second = repository.createCardVersion({
    sessionId: session.id,
    cards: [{ term: 'second' }],
    schemaVersion: '1.0',
    source: 'manual',
    validationStatus: 'valid',
  });

  assert.equal(first.version_number, 1);
  assert.equal(second.version_number, 2);
  assert.equal(repository.getCurrentCardVersion(session.id).id, second.id);
  assert.deepEqual(repository.listCardVersions(session.id).map(version => version.id), [second.id, first.id]);
  assert.equal(repository.db.prepare('SELECT COUNT(*) AS count FROM card_versions').get().count, 2);
});

test('does not promote an invalid card version to current', t => {
  const { db, repository, tempDir } = createTestRepository();
  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const session = repository.createSession();
  const valid = repository.createCardVersion({
    sessionId: session.id,
    cards: [{ term: 'valid' }],
    schemaVersion: '1.0',
    source: 'ai',
    validationStatus: 'valid',
  });
  repository.createCardVersion({
    sessionId: session.id,
    cards: [{ term: 'invalid' }],
    schemaVersion: '1.0',
    source: 'ai',
    validationStatus: 'invalid',
    validationErrors: ['examples are missing'],
  });

  assert.equal(repository.getCurrentCardVersion(session.id).id, valid.id);
});

test('does not create a card version when the saved content is unchanged', t => {
  const { db, repository, tempDir } = createTestRepository();
  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const session = repository.createSession();
  const first = repository.createCardVersion({
    sessionId: session.id,
    cards: [{ term: 'unchanged', examples: [{ en: 'Same.', zh: '相同。' }] }],
    schemaVersion: '1.0',
    source: 'manual',
    validationStatus: 'invalid',
  });
  const duplicate = repository.createCardVersion({
    sessionId: session.id,
    cards: [{ examples: [{ zh: '相同。', en: 'Same.' }], term: 'unchanged' }],
    schemaVersion: '1.0',
    source: 'ai',
    validationStatus: 'invalid',
  });

  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.unchanged, true);
  assert.equal(repository.listCardVersions(session.id).length, 1);
});

test('clears every session and its dependent records', t => {
  const { db, repository, tempDir } = createTestRepository();
  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const session = repository.createSession({ title: 'thickness' });
  const version = repository.createCardVersion({
    sessionId: session.id,
    cards: [{ term: 'thickness' }],
    schemaVersion: '1.0',
    source: 'manual',
    validationStatus: 'valid',
  });
  repository.addMessage({ sessionId: session.id, role: 'user', content: 'hi' });
  repository.createAnkiPreview({ sessionId: session.id, cardVersionId: version.id, cardIndex: 0, notes: [] });

  assert.equal(repository.clearSessions(), 1);
  assert.equal(repository.listSessions().length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM card_versions').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM anki_exports').get().count, 0);
});

test('deletes one session and its dependent records without touching other sessions', t => {
  const { db, repository, tempDir } = createTestRepository();
  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const doomed = repository.createSession({ title: 'doomed' });
  const kept = repository.createSession({ title: 'kept' });
  const doomedVersion = repository.createCardVersion({
    sessionId: doomed.id,
    cards: [{ term: 'doomed' }],
    schemaVersion: '1.0',
    source: 'manual',
    validationStatus: 'valid',
  });
  repository.addMessage({ sessionId: doomed.id, role: 'user', content: 'bye' });
  repository.createAnkiPreview({
    sessionId: doomed.id, cardVersionId: doomedVersion.id, cardIndex: 0, notes: [],
  });
  repository.addMessage({ sessionId: kept.id, role: 'user', content: 'still here' });

  assert.equal(repository.deleteSession(doomed.id), 1);
  assert.equal(repository.deleteSession(doomed.id), 0);
  assert.deepEqual(repository.listSessions().map(session => session.id), [kept.id]);
  assert.equal(repository.listMessages(kept.id).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM card_versions').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM anki_exports').get().count, 0);
});

test('keeps workspaces isolated by collection profile', t => {
  const { db, repository, tempDir } = createTestRepository();
  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const first = repository.ensureAnkiProfile({ name: 'Caro', collectionPath: '/profiles/Caro/collection.anki2' }).profile;
  repository.ensureAnkiProfileSettings(first.id);
  repository.beginAnkiProfileCreation({
    id: 'reading', name: 'Reading', collectionPath: '/profiles/Reading/collection.anki2',
    stagingPath: '/profiles/profile-staging/reading',
  });
  const second = repository.finishAnkiProfileCreation('reading');
  const carolSession = repository.createSession({ title: 'Caro card', profileId: first.id });
  const readingSession = repository.createSession({ title: 'Reading card', profileId: second.id });

  assert.deepEqual(repository.listSessions(first.id).map(session => session.id), [carolSession.id]);
  assert.deepEqual(repository.listSessions(second.id).map(session => session.id), [readingSession.id]);
  assert.equal(repository.getSession(carolSession.id, second.id), null);
  assert.equal(repository.clearSessions(second.id), 1);
  assert.equal(repository.getSession(carolSession.id, first.id)?.title, 'Caro card');
});
