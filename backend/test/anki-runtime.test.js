const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AnkiLocal, syncRequired } = require('../anki-local');

// The frozen runtime is what lets Caro Anki run without Anki Desktop or a system Python, so the whole
// action surface the app uses is exercised against it rather than only against the fixture.
const helperPath = path.resolve(__dirname, '../../tmp/anki-runtime/anki-helper/anki-helper');
const hasRuntime = fs.existsSync(helperPath);

test('the bundled Anki runtime serves a collection on its own',
  { skip: !hasRuntime, timeout: 120000 }, async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-runtime-test-'));
    const client = new AnkiLocal({
      collectionPath: path.join(tempDir, 'User 1', 'collection.anki2'),
      helperPath,
      timeoutMs: 60000,
    });
    t.after(() => client.close());
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    // A fresh collection appears with Anki's stock content plus the Caro note type.
    assert.deepEqual(await client.invoke('deckNames', {}), ['Default']);
    assert.equal(await client.invoke('currentDeckName', {}), 'Default');
    assert.ok((await client.invoke('modelNames', {})).includes('Basic'));
    assert.ok((await client.invoke('modelNames', {})).includes('English'));
    assert.deepEqual(await client.invoke('modelFieldNames', { modelName: 'English' }), [
      '意思', '含意', '字意', '註解', '詞彙', '詞彙US', '詞彙UK', '同義詞',
      '反義詞', '聯想詞', '類型', '類型標籤', '音標', '不規則', '範例',
    ]);
    const schemaModel = await client.invoke('createModel', {
      name: 'Runtime schema', fields: ['Prompt', 'Answer'], styling: '.card {}',
      templates: [{ name: 'Card 1', front: '{{Prompt}}', back: '{{Answer}}' }],
    });
    // A field is answered as the field and its own settings, defaulted the way Anki defaults a new field, so the
    // Fields panel never depends on which keys a collection happens to carry.
    assert.deepEqual(schemaModel.fields.map(field => field.name), ['Prompt', 'Answer']);
    assert.deepEqual(schemaModel.fields[0], {
      name: 'Prompt', font: 'Arial', size: 20, rtl: false, sticky: false, description: '', collapsed: false,
      htmlEditor: false,
    });
    assert.equal(schemaModel.sortFieldIndex, 0);
    assert.deepEqual((await client.invoke('addModelField', {
      modelName: 'Runtime schema', name: 'Hint', index: 1,
    })).fields.map(field => field.name), ['Prompt', 'Hint', 'Answer']);
    // A rename, a move and the settings are one write, and they land on the renamed field.
    assert.deepEqual((await client.invoke('updateModelField', {
      modelName: 'Runtime schema', fieldName: 'Hint', name: 'Clue', index: 2, font: 'Georgia', size: 34,
      rtl: true, sticky: true, description: 'A nudge toward the answer', collapsed: true, htmlEditor: true,
    })).fields.at(2), {
      name: 'Clue', font: 'Georgia', size: 34, rtl: true, sticky: true,
      description: 'A nudge toward the answer', collapsed: true, htmlEditor: true,
    });
    assert.equal((await client.invoke('addModelTemplate', {
      modelName: 'Runtime schema', name: 'Reverse', front: '{{Answer}}', back: '{{Prompt}}',
    })).templates.length, 2);
    assert.equal((await client.invoke('deleteModelTemplate', {
      modelName: 'Runtime schema', templateName: 'Reverse',
    })).templates.length, 1);
    assert.deepEqual((await client.invoke('deleteModelField', {
      modelName: 'Runtime schema', fieldName: 'Clue',
    })).fields.map(field => field.name), ['Prompt', 'Answer']);
    // The sort field is the note type's own scalar, and Anki keeps it across a rename of the note type.
    assert.equal((await client.invoke('updateModel', {
      modelName: 'Runtime schema', sortField: 'Answer',
    })).sortFieldIndex, 1);
    assert.equal((await client.invoke('updateModel', {
      modelName: 'Runtime schema', name: 'Runtime schema renamed',
    })).name, 'Runtime schema renamed');
    assert.equal((await client.invoke('modelInfo', { modelName: 'Runtime schema renamed' })).sortFieldIndex, 1);
    await client.invoke('deleteModel', { modelName: 'Runtime schema renamed' });
    assert.ok(!(await client.invoke('modelNames', {})).includes('Runtime schema renamed'));
    assert.equal(fs.existsSync(client.collectionPath), true);

    const noteId = await client.invoke('createBrowserNote', {
      deckName: 'Default',
      modelName: 'English',
      fields: { 詞彙: 'thickness', 意思: 'the state of being thick' },
      tags: ['caro-test'],
      options: { allowDuplicate: true },
    });
    assert.ok(Number.isSafeInteger(noteId.noteId));
    assert.equal(noteId.fields.詞彙.value, 'thickness');
    assert.deepEqual(noteId.tags, ['caro-test']);

    const [raw] = await client.invoke('notesInfo', { notes: [noteId.noteId] });
    assert.equal(raw.fields.意思.value, 'the state of being thick');
    assert.deepEqual(await client.invoke('findNotes', { query: 'tag:caro-test' }), [noteId.noteId]);
    assert.equal((await client.invoke('browserNoteInfo', { noteId: noteId.noteId })).deckName, 'Default');
    assert.deepEqual(Object.keys(await client.invoke('browserNoteInfo', {
      noteId: noteId.noteId, select: ['id', 'fields'],
    })).sort(), ['fields', 'noteId']);

    // The sync reminder is computed from the collection's own stamps, so the action has to work on the
    // real runtime: a collection that never synced reports a pending sync as soon as it holds content.
    const stamps = await client.syncStamps();
    assert.equal(stamps.lastSync, 0);
    assert.ok(stamps.mod > 0 && stamps.scm > 0);
    assert.equal(syncRequired(stamps), 'NORMAL_SYNC');

    const rows = await client.invoke('searchNoteRows', {
      query: '', sortField: 'term', sortDirection: 'asc',
    });
    assert.deepEqual(rows.notes.map(note => note.term), ['thickness']);
    assert.equal(rows.notes[0].meaning, 'the state of being thick');
    assert.deepEqual(rows.notes[0].tags, ['caro-test']);
    assert.deepEqual(Object.keys((await client.invoke('searchNoteRows', {
      query: '', sortField: 'createdAt', sortDirection: 'desc', select: ['id', 'modelName'],
    })).notes[0]).sort(), ['modelName', 'noteId']);
    const paged = await client.invoke('searchNotes', {
      query: '', skip: 0, limit: 10, sortField: 'createdAt', sortDirection: 'desc',
    });
    assert.equal(paged.total, 1);

    // Fields, tags, scheduling, flags, copy, and delete all go through Anki's own managers.
    await client.invoke('updateNoteFields', { note: { id: noteId.noteId, fields: { 意思: 'thickness' } } });
    await client.invoke('addTags', { notes: [noteId.noteId], tags: ['food'] });
    assert.ok((await client.invoke('getTags', {})).includes('food'));
    await client.invoke('removeTags', { notes: [noteId.noteId], tags: ['food'] });
    assert.deepEqual((await client.invoke('notesInfo', { notes: [noteId.noteId] }))[0].tags, ['caro-test']);
    await client.invoke('addTags', { notes: [noteId.noteId], tags: ['unused'] });
    await client.invoke('removeTags', { notes: [noteId.noteId], tags: ['unused'] });
    assert.ok((await client.invoke('clearUnusedTags', {})) >= 1);
    assert.ok(!(await client.invoke('getTags', {})).includes('unused'));
    await client.invoke('addTags', { notes: [noteId.noteId], tags: ['family', 'family::fresh'] });
    await client.invoke('renameTag', { oldName: 'family', name: 'meal' });
    assert.deepEqual((await client.invoke('notesInfo', { notes: [noteId.noteId] }))[0].tags,
      ['caro-test', 'meal', 'meal::fresh']);
    await client.invoke('deleteTag', { name: 'meal' });
    assert.deepEqual((await client.invoke('notesInfo', { notes: [noteId.noteId] }))[0].tags, ['caro-test']);

    const { cards } = await client.invoke('changeDeckForNotes', { notes: [noteId.noteId], deck: '_Todo' });
    assert.equal(cards ?? 1, 1);
    assert.equal((await client.invoke('browserNoteInfo', { noteId: noteId.noteId })).deckName, '_Todo');
    await client.invoke('setDueDateForNotes', { notes: [noteId.noteId], days: '1-3' });
    await client.invoke('setUserFlagForNotes', { notes: [noteId.noteId], flag: 2 });
    const flagged = await client.invoke('browserNoteInfo', { noteId: noteId.noteId });
    assert.equal(flagged.flag, 2);
    assert.ok(flagged.dueAt);

    const { copiedIds } = await client.invoke('copyNotes', { notes: [noteId.noteId] });
    assert.equal(copiedIds.length, 1);
    assert.ok(Number.isSafeInteger(copiedIds[0]));
    await client.invoke('deleteNotes', { notes: [noteId.noteId, copiedIds[0]] });
    assert.deepEqual(await client.invoke('findNotes', { query: '' }), []);
  });

test('a summary row reads the fields it names and falls back the way Anki does',
  { skip: !hasRuntime, timeout: 120000 }, async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-runtime-rows-'));
    const client = new AnkiLocal({
      collectionPath: path.join(tempDir, 'User 1', 'collection.anki2'),
      helperPath,
      timeoutMs: 60000,
    });
    t.after(() => client.close());
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    // A row is normalised lazily, so the note types these readings come from say what each one reads: the
    // term field, the meaning field, the model's sort field, then the first field that is not empty. Anki
    // refuses a note with an empty first field, so a note without a term is one with an empty 詞彙.
    const add = fields => client.invoke('createBrowserNote', {
      deckName: 'Default', modelName: 'English', fields, options: { allowDuplicate: true },
    });
    await add({ 詞彙: 'thickness', 意思: 'the state of being thick' });
    await add({ 意思: 'plain meaning' });
    await add({ 詞彙: 'Zebra', 意思: 'a striped animal' });

    const ascending = await client.invoke('searchNoteRows', {
      query: '', sortField: 'term', sortDirection: 'asc', includeIds: true,
    });
    assert.deepEqual(ascending.notes.map(note => note.term), ['plain meaning', 'thickness', 'Zebra']);
    assert.deepEqual(ascending.notes.map(note => note.meaning),
      ['plain meaning', 'the state of being thick', 'a striped animal']);
    assert.deepEqual(ascending.noteIds, ascending.notes.map(note => note.noteId));
    assert.equal(ascending.total, 3);
    assert.deepEqual(Object.keys(ascending.notes[0]).sort(),
      ['deckName', 'dueAt', 'flag', 'meaning', 'modelName', 'noteId', 'tags', 'term']);
    assert.equal(ascending.notes[0].deckName, 'Default');

    const descending = await client.invoke('searchNoteRows', {
      query: '', sortField: 'term', sortDirection: 'desc',
    });
    assert.deepEqual(descending.notes.map(note => note.term), ['Zebra', 'thickness', 'plain meaning']);

    const paged = await client.invoke('searchNoteRows', {
      query: '', skip: 1, limit: 1, sortField: 'term', sortDirection: 'asc',
    });
    assert.deepEqual(paged.notes.map(note => note.term), ['thickness']);
    assert.equal(paged.total, 3);

    const byMeaning = await client.invoke('searchNoteRows', {
      query: '', sortField: 'meaning', sortDirection: 'asc',
    });
    assert.deepEqual(byMeaning.notes.map(note => note.term),
      ['Zebra', 'plain meaning', 'thickness']);

    const matched = await client.invoke('searchNoteRows', {
      query: 'thickness', sortField: 'term', sortDirection: 'asc',
    });
    assert.deepEqual(matched.notes.map(note => note.meaning), ['the state of being thick']);
    assert.equal(matched.total, 1);
  });

test('the bundled runtime is reused across calls instead of respawning',
  { skip: !hasRuntime, timeout: 120000 }, async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-runtime-reuse-'));
    const client = new AnkiLocal({
      collectionPath: path.join(tempDir, 'User 1', 'collection.anki2'),
      helperPath,
      timeoutMs: 60000,
    });
    t.after(() => client.close());
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    await client.invoke('deckNames', {});
    const child = client.bridge.child;
    await client.invoke('deckNames', {});
    await client.invoke('deckNames', {});

    assert.equal(client.bridge.child, child);
  });

test('a missing bundled runtime reports a setup error instead of a spawn failure', async () => {
  const client = new AnkiLocal({
    collectionPath: '/tmp/collection.anki2',
    helperPath: '/nonexistent/anki-helper',
    timeoutMs: 1000,
  });
  await assert.rejects(client.invoke('deckNames', {}), error => {
    assert.equal(error.statusCode, 503);
    assert.match(error.message, /Bundled Anki runtime is missing/);
    return true;
  });
});
