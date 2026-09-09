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
    assert.deepEqual(await client.invoke('deckConfigs', {}), [
      { id: 1, name: 'Default', decks: ['Default'], removable: false },
    ]);
    assert.equal(await client.invoke('currentDeckName', {}), 'Default');
    assert.ok((await client.invoke('modelNames', {})).includes('Basic'));
    assert.ok((await client.invoke('modelNames', {})).includes('Caro'));
    assert.deepEqual(await client.invoke('modelFieldNames', { modelName: 'Caro' }),
      ['Front', 'Back', 'Notes']);
    const backupSettings = await client.invoke('backupSettings', {});
    assert.ok(Object.values(backupSettings).every(value => Number.isSafeInteger(value) && value >= 0));
    const changedBackups = await client.invoke('updateBackupSettings', {
      ...backupSettings, daily: backupSettings.daily + 1, minimumIntervalMins: 0,
    });
    assert.equal(changedBackups.daily, backupSettings.daily + 1);
    assert.equal(typeof (await client.invoke('createBackup', { force: true })).created, 'boolean');
    const database = await client.invoke('checkDatabase', {});
    assert.equal(database.healthy, true);
    assert.equal(typeof database.report, 'string');
    const media = await client.invoke('checkMedia', {});
    assert.equal(Array.isArray(media.missing), true);
    assert.equal(Array.isArray(media.unused), true);
    assert.equal(typeof media.report, 'string');
    await client.invoke('createDeck', { name: 'Automatic backup probe' });
    assert.equal((await client.invoke('createBackup', { force: false })).created, false);
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
      modelName: 'Caro',
      fields: { Front: 'thickness', Back: 'the state of being thick' },
      tags: ['caro-test'],
      options: { allowDuplicate: true },
    });
    assert.ok(Number.isSafeInteger(noteId.noteId));
    assert.equal(noteId.fields.Front.value, 'thickness');
    assert.deepEqual(noteId.tags, ['caro-test']);

    const [raw] = await client.invoke('notesInfo', { notes: [noteId.noteId] });
    assert.equal(raw.fields.Back.value, 'the state of being thick');
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
      query: '', sortField: 'Front', sortDirection: 'asc', fieldNames: ['Front', 'Back'],
    });
    assert.deepEqual(rows.notes.map(note => note.fieldValues.Front), ['thickness']);
    assert.equal(rows.notes[0].fieldValues.Back, 'the state of being thick');
    // The note's identity is its note type's own sort field, which is what a table falls back to when the
    // columns on screen are dragged away from the content.
    assert.equal(rows.notes[0].sortField, 'thickness');
    assert.deepEqual(rows.notes[0].tags, ['caro-test']);
    assert.deepEqual(Object.keys((await client.invoke('searchNoteRows', {
      query: '', sortField: 'createdAt', sortDirection: 'desc', select: ['id', 'modelName'],
    })).notes[0]).sort(), ['modelName', 'noteId']);
    const paged = await client.invoke('searchNotes', {
      query: '', skip: 0, limit: 10, sortField: 'createdAt', sortDirection: 'desc',
    });
    assert.equal(paged.total, 1);

    // Fields, tags, scheduling, flags, copy, and delete all go through Anki's own managers.
    await client.invoke('updateNoteFields', { note: { id: noteId.noteId, fields: { Back: 'thickness' } } });
    const replaced = await client.invoke('findAndReplace', {
      notes: [noteId.noteId], find: 'THICKNESS', replace: 'density', field: 'Back',
      ignoreCase: true, regularExpression: false,
    });
    assert.deepEqual(replaced, { changedNoteIds: [noteId.noteId], changedCount: 1, matchCount: 1 });
    assert.equal((await client.invoke('notesInfo', { notes: [noteId.noteId] }))[0].fields.Back.value, 'density');
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

test('a summary row reads the field names it was given and falls back the way Anki does',
  { skip: !hasRuntime, timeout: 120000 }, async t => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-runtime-rows-'));
    const client = new AnkiLocal({
      collectionPath: path.join(tempDir, 'User 1', 'collection.anki2'),
      helperPath,
      timeoutMs: 60000,
    });
    t.after(() => client.close());
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    // A row answers the field names the call asked for, keyed by the name the note type spells them with, so
    // the app never has to know what a note type calls anything. A note whose type lacks a name answers
    // nothing for it rather than losing the row, and a note with an empty field answers an empty string.
    // Anki refuses a note whose first field is empty, so the one created with only a front is the one whose
    // back reads as empty.
    const add = fields => client.invoke('createBrowserNote', {
      deckName: 'Default', modelName: 'Caro', fields, options: { allowDuplicate: true },
    });
    await add({ Front: 'thickness', Back: 'the state of being thick' });
    await add({ Front: 'plain meaning' });
    await add({ Front: 'Zebra', Back: 'a striped animal' });

    const fieldNames = ['Front', 'Back'];
    const ascending = await client.invoke('searchNoteRows', {
      query: '', sortField: 'Front', sortDirection: 'asc', includeIds: true, fieldNames,
    });
    assert.deepEqual(ascending.notes.map(note => note.fieldValues.Front),
      ['plain meaning', 'thickness', 'Zebra']);
    assert.deepEqual(ascending.notes.map(note => note.fieldValues.Back),
      ['', 'the state of being thick', 'a striped animal']);
    assert.deepEqual(ascending.noteIds, ascending.notes.map(note => note.noteId));
    assert.equal(ascending.total, 3);
    assert.deepEqual(Object.keys(ascending.notes[0]).sort(), ['deckName', 'dueAt', 'ease', 'fieldValues', 'flag',
      'interval', 'lapses', 'modelName', 'noteId', 'reps', 'sortField', 'tags']);
    assert.equal(ascending.notes[0].deckName, 'Default');
    // A card that has never been answered has no schedule of its own, so the row reports the deck's new-card
    // schedule instead of nothing: the starting ease and the first interval come from the deck's own config.
    assert.equal(ascending.notes[0].ease, 250);
    assert.equal(ascending.notes[0].interval, 1);
    assert.equal(ascending.notes[0].reps, 0);
    assert.equal(ascending.notes[0].lapses, 0);
    // A note with an empty sort field falls back to its first field that holds anything, which is its identity.
    assert.deepEqual(ascending.notes.map(note => note.sortField), ['plain meaning', 'thickness', 'Zebra']);

    const descending = await client.invoke('searchNoteRows', {
      query: '', sortField: 'Front', sortDirection: 'desc', fieldNames,
    });
    assert.deepEqual(descending.notes.map(note => note.fieldValues.Front),
      ['Zebra', 'thickness', 'plain meaning']);

    const paged = await client.invoke('searchNoteRows', {
      query: '', skip: 1, limit: 1, sortField: 'Front', sortDirection: 'asc', fieldNames,
    });
    assert.deepEqual(paged.notes.map(note => note.fieldValues.Front), ['thickness']);
    assert.equal(paged.total, 3);

    // A table sorts by the column it shows, so any field name the call also asked to read is a sort field.
    const byBack = await client.invoke('searchNoteRows', {
      query: '', sortField: 'Back', sortDirection: 'asc', fieldNames,
    });
    // A note with no value for the field being sorted by cannot take a place in that order, so it pages after
    // the notes that have one instead of being dropped.
    assert.deepEqual(byBack.notes.map(note => note.fieldValues.Front),
      ['Zebra', 'thickness', 'plain meaning']);

    // A name the call did not ask to read is not a sort field, so the request falls back to newest-first
    // rather than failing — `Back` is not in `fieldNames`, so it cannot order the page.
    const notRead = await client.invoke('searchNoteRows', {
      query: '', sortField: 'Back', sortDirection: 'asc', fieldNames: ['Front'],
    });
    assert.deepEqual(notRead.notes.map(note => note.fieldValues.Front),
      ['thickness', 'plain meaning', 'Zebra']);

    const matched = await client.invoke('searchNoteRows', {
      query: 'thickness', sortField: 'Front', sortDirection: 'asc', fieldNames,
    });
    assert.deepEqual(matched.notes.map(note => note.fieldValues.Back), ['the state of being thick']);
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
