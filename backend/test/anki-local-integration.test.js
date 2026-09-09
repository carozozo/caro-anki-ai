const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AnkiLocal } = require('../anki-local');

// Only runs on a machine that has Anki's own Python; the bundled runtime is covered separately by
// anki-runtime.test.js, which needs no external interpreter.
const pythonPath = path.join(
  os.homedir(),
  'Library/Application Support/AnkiProgramFiles/.venv/bin/python',
);

test('local bridge reads and writes a temporary Anki collection',
  { skip: !fs.existsSync(pythonPath), timeout: 60000 }, async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-local-test-'));
    const collectionPath = path.join(tempDir, 'User 1', 'collection.anki2');
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const client = new AnkiLocal({
      collectionPath,
      helperPath: null,
      pythonPath,
      bridgePath: path.resolve(__dirname, '../anki_bridge.py'),
      timeoutMs: 60000,
    });
    t.after(() => client.close());

    assert.ok((await client.invoke('deckNames', {})).includes('Default'));
    assert.equal(fs.existsSync(collectionPath), true);
    assert.ok((await client.invoke('modelNames', {})).includes('Basic'));
    const noteId = await client.invoke('addNote', {
      note: {
        deckName: 'Default', modelName: 'Basic', fields: { Front: 'bridge test', Back: 'ok' },
        tags: ['caro-test'], options: { allowDuplicate: false },
      },
    });
    assert.ok(Number.isSafeInteger(noteId));
    const notes = await client.invoke('notesInfo', { notes: [noteId] });
    assert.equal(notes[0].fields.Front.value, 'bridge test');
    assert.deepEqual(await client.invoke('findNotes', { query: 'tag:caro-test' }), [noteId]);

    const searchParams = { query: 'tag:caro-test', skip: 0, limit: 10 };
    const byMeaning = await client.invoke('searchNotes', { ...searchParams, sortField: 'meaning', sortDirection: 'asc' });
    assert.deepEqual(byMeaning.notes.map(note => note.noteId), [noteId]);
    const byTerm = await client.invoke('searchNotes', { ...searchParams, sortField: 'term', sortDirection: 'desc' });
    assert.deepEqual(byTerm.notes.map(note => note.noteId), [noteId]);
    const summary = await client.invoke('searchNoteRows', {
      query: 'tag:caro-test', sortField: 'term', sortDirection: 'asc',
    });
    assert.deepEqual(summary.notes.map(note => note.noteId), [noteId]);
    assert.equal(summary.notes[0].term, 'bridge test');
    await client.invoke('setDueDate', { cards: notes[0].cards, days: '5' });
    const byDue = await client.invoke('searchNotes', { ...searchParams, sortField: 'dueAt', sortDirection: 'asc' });
    assert.deepEqual(byDue.notes.map(note => note.noteId), [noteId]);
    assert.ok(byDue.notes[0].dueAt);
  });
