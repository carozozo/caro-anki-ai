const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./server-process');

test('standalone browser API manages notes without an external Anki process', { timeout: 10000 }, async t => {
  const { port, stop } = await startServer();
  t.after(() => stop());

  const request = async (route, body, headers = {}, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json(), timing: response.headers.get('Server-Timing') };
  };

  // The fake collection is an English-shaped one, so the app is pointed at its note type the way a user would
  // rather than left on the neutral default it ships — which no collection has until one creates it.
  assert.equal((await request('anki-settings', { modelName: 'English' }, {}, 'PUT')).status, 200);

  const meta = await request('anki/decks', undefined, {}, 'GET');
  assert.deepEqual(meta.payload.decks, ['Default', '_Todo']);
  assert.deepEqual(meta.payload.models, ['Basic', 'English']);
  // The candidate field list is every field name any note type has, in the collection's own spelling and
  // deduplicated, which is what the user picks their table columns from. It is not the app's idea of a note:
  // `Term` comes from the English note type, `Front` from Basic.
  assert.ok(meta.payload.modelFields.includes('Term'));
  assert.ok(meta.payload.modelFields.includes('Examples'));
  assert.ok(meta.payload.modelFields.includes('Front'));
  assert.equal(new Set(meta.payload.modelFields).size, meta.payload.modelFields.length);

  const basicModel = await request('anki/models/Basic', undefined, {}, 'GET');
  assert.deepEqual(basicModel.payload.model.fields.map(field => field.name), ['Front', 'Back']);
  // A field answers with every setting the Fields panel draws, defaulted the way Anki defaults a new field.
  assert.deepEqual(basicModel.payload.model.fields[0], {
    name: 'Front', font: 'Arial', size: 20, rtl: false, sticky: false, description: '', collapsed: false,
    htmlEditor: false,
  });
  assert.equal(basicModel.payload.model.sortFieldIndex, 0);

  const createdModel = await request('anki/models', {
    name: 'Study', fields: ['Prompt', 'Answer'], styling: '.card { font-size: 20px; }',
    templates: [{ name: 'Card 1', front: '{{Prompt}}', back: '{{FrontSide}}<hr id=answer>{{Answer}}' }],
  });
  assert.equal(createdModel.status, 201);
  assert.deepEqual(createdModel.payload.model.fields.map(field => field.name), ['Prompt', 'Answer']);
  assert.equal((await request('anki/models', undefined, {}, 'GET')).payload.models
    .find(model => model.name === 'Study').templateCount, 1);
  const addedField = await request('anki/models/Study/fields', { name: 'Hint', index: 1 });
  assert.deepEqual(addedField.payload.model.fields.map(field => field.name), ['Prompt', 'Hint', 'Answer']);
  const renamedField = await request('anki/models/Study/fields/Hint', { name: 'Clue' }, {}, 'PUT');
  assert.deepEqual(renamedField.payload.model.fields.map(field => field.name), ['Prompt', 'Clue', 'Answer']);
  const configuredField = await request('anki/models/Study/fields/Prompt', {
    font: 'Georgia', size: 28, rtl: true, sticky: true, description: 'The word being asked for', collapsed: true,
    htmlEditor: true,
  }, {}, 'PUT');
  assert.deepEqual(configuredField.payload.model.fields[0], {
    name: 'Prompt', font: 'Georgia', size: 28, rtl: true, sticky: true,
    description: 'The word being asked for', collapsed: true, htmlEditor: true,
  });
  // The sort field belongs to the note type, and a renamed field keeps the settings it was configured with.
  const sorted = await request('anki/models/Study', { sortField: 'Answer' }, {}, 'PUT');
  assert.equal(sorted.payload.model.sortFieldIndex, 2);
  assert.equal((await request('anki/models/Study/fields/Clue', { name: 'Prompt' }, {}, 'PUT')).status, 500);
  assert.deepEqual((await request('anki/models/Study?select=sortFieldIndex,fields', undefined, {}, 'GET'))
    .payload.model.fields.map(field => field.name), ['Prompt', 'Clue', 'Answer']);
  assert.equal((await request('anki/models/Study/fields/Prompt', { size: 0 }, {}, 'PUT')).status, 400);
  assert.equal((await request('anki/models/Study/fields/Prompt', { font: 12 }, {}, 'PUT')).status, 400);
  assert.equal((await request('anki/models/Study/fields/Prompt', {}, {}, 'PUT')).status, 400);
  const addedTemplate = await request('anki/models/Study/templates', {
    name: 'Reverse', front: '{{Answer}}', back: '{{FrontSide}}<hr id=answer>{{Prompt}}',
  });
  assert.equal(addedTemplate.payload.model.templates.length, 2);
  const editedTemplate = await request('anki/models/Study/templates/Reverse', {
    name: 'Answer first', front: '<main>{{Answer}}</main>', back: '{{Prompt}}', styling: '.card { color: teal; }',
  }, {}, 'PUT');
  assert.equal(editedTemplate.payload.model.templates[1].name, 'Answer first');
  assert.equal(editedTemplate.payload.model.styling, '.card { color: teal; }');
  assert.equal((await request('anki/models/Study/templates/Answer%20first', undefined, {}, 'DELETE')).payload.model.templates.length, 1);
  assert.deepEqual((await request('anki/models/Study/fields/Clue', undefined, {}, 'DELETE')).payload.model.fields
    .map(field => field.name), ['Prompt', 'Answer']);
  assert.equal((await request('anki/models/Study', { sortField: 'Answer' }, {}, 'PUT')).payload.model.sortFieldIndex, 1);
  const renamedModel = await request('anki/models/Study', { name: 'Study Note' }, {}, 'PUT');
  assert.equal(renamedModel.payload.model.name, 'Study Note');
  assert.equal((await request('anki/models/Study%20Note', undefined, {}, 'DELETE')).payload.deleted, 'Study Note');
  assert.equal((await request('anki/models', { name: 'Blocked', fields: ['Front'], templates: [{
    name: 'Card 1', front: '{{Front}}', back: '{{Front}}',
  }], styling: '' }, { Origin: 'https://untrusted.example' })).status, 403);

  const template = await request('anki/notes/new', undefined, {}, 'GET');
  assert.equal(template.payload.note.deckName, '_Todo');
  assert.ok(template.payload.note.fields.some(field => field.name === 'Term'));
  const basicTemplate = await request('anki/notes/new?modelName=Basic', undefined, {}, 'GET');
  assert.equal(basicTemplate.payload.note.modelName, 'Basic');
  assert.deepEqual(basicTemplate.payload.note.fields.map(field => field.name), ['Front', 'Back']);

  const first = await request('anki/notes', {
    fields: { Term: 'apple', Meaning: 'a fruit' }, tags: ['fruit'], deckName: 'Words',
  });
  const second = await request('anki/notes', {
    fields: { Term: 'banana', Meaning: 'a yellow fruit' }, tags: ['fruit'], deckName: 'Words',
  });
  const basic = await request('anki/notes', {
    modelName: 'Basic', fields: { Front: 'pear', Back: 'a green fruit' }, tags: ['fruit'], deckName: 'Basics',
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(basic.payload.note.modelName, 'Basic');
  assert.ok(Number.isSafeInteger(first.payload.note.id));

  // A table row answers Anki's own row keys plus the field values its columns asked for, named the way the
  // note type spells them. `fields=Term,Meaning` is what the columns on screen are, so the app never has to
  // know what a note type is called or which of its fields is the interesting one.
  const tableFields = 'modelName,tags,createdAt,deckName,dueAt,flag,sortField,fieldValues,ease,interval,reps,lapses';
  const tableQuery = `anki/notes?query=deck:%22Words%22&select=${tableFields}&fields=Term,Meaning`;
  const termOf = note => note.fieldValues.Term;
  const summary = await request(
    `${tableQuery}&sortField=Term&sortDirection=asc`, undefined, {}, 'GET');
  assert.match(summary.timing, /^app;dur=\d+(?:\.\d+)?$/);
  assert.deepEqual(summary.payload.notes.map(termOf), ['apple', 'banana']);
  assert.deepEqual(summary.payload.notes.map(note => note.modelName), ['English', 'English']);
  assert.deepEqual(summary.payload.notes.map(note => note.sortField), ['apple', 'banana']);
  assert.deepEqual(summary.payload.notes[0].fieldValues, { Term: 'apple', Meaning: 'a fruit' });
  assert.deepEqual(summary.payload.notes[0].tags, ['fruit']);
  assert.equal(summary.payload.notes[0].fields, undefined);
  // A field a note type does not have answers nothing rather than losing the row: one table shows a
  // collection of mixed note types.
  const mixedQuery = `anki/notes?select=${tableFields}&fields=Term,Front`;
  const mixed = await request(`${mixedQuery}&sortField=Term&sortDirection=asc`, undefined, {}, 'GET');
  assert.deepEqual(mixed.payload.notes.find(note => note.modelName === 'Basic').fieldValues, { Front: 'pear' });
  assert.deepEqual(mixed.payload.notes.find(note => note.modelName === 'English').fieldValues,
    { Term: 'apple' });
  const ignoredSummary = await request('anki/notes?query=deck:%22Words%22&summary=true', undefined, {}, 'GET');
  assert.ok(ignoredSummary.payload.notes[0].fields);
  const firstPage = await request(
    `${tableQuery}&sortField=Term&sortDirection=asc`
      + '&skip=0&limit=1&includeIds=true', undefined, {}, 'GET');
  assert.deepEqual(firstPage.payload.notes.map(termOf), ['apple']);
  assert.deepEqual(firstPage.payload.noteIds, [first.payload.note.id, second.payload.note.id]);
  assert.equal(firstPage.payload.hasMore, true);
  const secondPage = await request(
    `${tableQuery}&sortField=Term&sortDirection=asc&skip=1&limit=1`,
    undefined, {}, 'GET');
  assert.deepEqual(secondPage.payload.notes.map(termOf), ['banana']);
  assert.equal(secondPage.payload.noteIds, undefined);
  assert.equal(secondPage.payload.hasMore, false);
  const pastEnd = await request(
    `anki/notes?query=deck:%22Words%22&select=${tableFields}&skip=5&limit=2`, undefined, {}, 'GET');
  assert.deepEqual(pastEnd.payload.notes, []);
  assert.equal(pastEnd.payload.total, 2);
  assert.equal(pastEnd.payload.hasMore, false);
  const clamped = await request(
    `anki/notes?query=deck:%22Words%22&select=${tableFields}&limit=9999`, undefined, {}, 'GET');
  assert.equal(clamped.payload.limit, 500);
  assert.equal(clamped.payload.notes.length, 2);

  // A read may name the fields it answers with. Asking for every column must equal asking for none, which is
  // what keeps the selectable list from drifting away from the shape the endpoint actually returns. This base
  // carries no `select` of its own, so each case below is the only selection in the request.
  const sortedWords = 'anki/notes?query=deck:%22Words%22&sortField=Term&sortDirection=asc&fields=Term,Meaning';
  const everyRowColumn = await request(
    `${sortedWords}&select=id,fieldValues,sortField,modelName,tags,createdAt,deckName,dueAt,flag,`
      + 'ease,interval,reps,lapses',
    undefined, {}, 'GET');
  assert.deepEqual(everyRowColumn.payload.notes, summary.payload.notes);
  const termOnly = await request(`${sortedWords}&select=fieldValues`, undefined, {}, 'GET');
  assert.deepEqual(termOnly.payload.notes, [
    { id: first.payload.note.id, fieldValues: { Term: 'apple', Meaning: 'a fruit' } },
    { id: second.payload.note.id, fieldValues: { Term: 'banana', Meaning: 'a yellow fruit' } }]);
  assert.equal(termOnly.payload.total, 2);
  // A `select` that asks for a detail-only field is the note read, not a table row, so the same endpoint
  // answers whichever shape the caller named.
  const detailSelect = await request(`${sortedWords}&select=fields`, undefined, {}, 'GET');
  assert.deepEqual(detailSelect.payload.notes.map(note => note.fields[0].name), ['Meaning', 'Meaning']);

  const rowsSelect = await request(`${sortedWords}&select=modelName`, undefined, {}, 'GET');
  assert.deepEqual(Object.keys(rowsSelect.payload.notes[0]), ['id', 'modelName']);
  assert.deepEqual(rowsSelect.payload.notes.map(note => note.modelName), ['English', 'English']);
  const badSelect = await request(`${sortedWords}&select=nope`, undefined, {}, 'GET');
  assert.equal(badSelect.status, 400);
  assert.match(badSelect.payload.error,
    /^select must be one of: id, .* flag, ease, interval, reps, lapses, fieldValues$/);
  const decks = (await request('anki/decks', undefined, {}, 'GET')).payload;
  assert.deepEqual((await request('anki/decks?select=models', undefined, {}, 'GET')).payload,
    { ok: true, models: decks.models });
  assert.deepEqual((await request('anki/models?select=name', undefined, {}, 'GET')).payload.models,
    decks.models.map(name => ({ name })));
  assert.deepEqual(Object.keys((await request('anki/models/Basic?select=styling', undefined, {}, 'GET')).payload.model),
    ['name', 'styling']);
  assert.deepEqual(Object.keys(
    (await request('anki/models/Basic?select=fields,sortFieldIndex', undefined, {}, 'GET')).payload.model),
  ['name', 'fields', 'sortFieldIndex']);
  assert.match((await request('anki/models/Basic?select=nope', undefined, {}, 'GET')).payload.error,
    /select must be one of: name, fields, sortFieldIndex, templates, styling/);
  assert.deepEqual(Object.keys((await request('anki/tags?select=total', undefined, {}, 'GET')).payload),
    ['ok', 'total']);
  assert.deepEqual((await request('anki/tags?limit=500', undefined, {}, 'GET')).payload.tags, ['fruit']);
  assert.deepEqual((await request('anki/notes/new?select=deckName', undefined, {}, 'GET')).payload.note,
    { id: null, deckName: '_Todo' });

  const firstId = first.payload.note.id;
  const secondId = second.payload.note.id;
  const updated = await request(`anki/notes/${firstId}`, { fields: { Meaning: 'a red fruit' } }, {}, 'PUT');
  assert.equal(updated.status, 200);
  const detail = await request(`anki/notes/${firstId}`, undefined, {}, 'GET');
  assert.equal(detail.payload.note.fields.find(field => field.name === 'Meaning').value, 'a red fruit');
  const cardPreview = await request(`anki/notes/${firstId}/preview`, undefined, {}, 'GET');
  assert.equal(cardPreview.status, 200);
  assert.equal(cardPreview.payload.preview.cards[0].front, 'apple');
  assert.match(cardPreview.payload.preview.cards[0].back, /a red fruit/);
  const everyNoteColumn = await request(`anki/notes/${firstId}?select=`
    + 'id,createdAt,modelName,tags,fields,sortField,preview,deckName,dueAt,flag,ease,interval,reps,lapses',
    undefined, {}, 'GET');
  assert.deepEqual(everyNoteColumn.payload.note, detail.payload.note);
  assert.deepEqual(Object.keys(
    (await request(`anki/notes/${firstId}?select=preview`, undefined, {}, 'GET')).payload.note), ['id', 'preview']);
  assert.deepEqual(Object.keys(
    (await request(`anki/notes/${firstId}?select=fields`, undefined, {}, 'GET')).payload.note), ['id', 'fields']);
  const badNoteSelect = await request(`anki/notes/${firstId}?select=nope`, undefined, {}, 'GET');
  assert.equal(badNoteSelect.status, 400);
  assert.match(badNoteSelect.payload.error, /select must be one of: id, createdAt, modelName, tags, fields/);

  const tagged = await request(`anki/notes/${firstId}/tags`, { add: ['food'] }, {}, 'PUT');
  assert.deepEqual(tagged.payload.note.tags, ['fruit', 'food']);
  assert.deepEqual((await request('anki/tags?query=foo', undefined, {}, 'GET')).payload.tags, ['food']);
  assert.deepEqual((await request('anki/tags?limit=1', undefined, {}, 'GET')).payload.tags, ['food']);
  assert.deepEqual((await request('anki/tags?limit=500', undefined, {}, 'GET')).payload.tags, ['food', 'fruit']);
  assert.deepEqual((await request('anki/tags?all=true', undefined, {}, 'GET')).payload.tags, ['food', 'fruit']);

  await request(`anki/notes/${firstId}/tags`, { add: ['unused'] }, {}, 'PUT');
  await request(`anki/notes/${firstId}/tags`, { remove: ['unused'] }, {}, 'PUT');
  assert.deepEqual((await request('anki/tags?query=unused', undefined, {}, 'GET')).payload.tags, ['unused']);
  const clearedTags = await request('anki/tags?unused=true', undefined, {}, 'DELETE');
  assert.equal(clearedTags.payload.cleared, 1);
  assert.deepEqual((await request('anki/tags?query=unused', undefined, {}, 'GET')).payload.tags, []);

  await request(`anki/notes/${firstId}/tags`, { add: ['fruit::fresh'] }, {}, 'PUT');
  const renamedTag = await request('anki/tags/fruit', { name: 'produce' }, {}, 'PUT');
  assert.deepEqual(renamedTag.payload.tag, { oldName: 'fruit', name: 'produce' });
  assert.deepEqual((await request('anki/tags?all=true', undefined, {}, 'GET')).payload.tags,
    ['food', 'produce', 'produce::fresh']);
  const deletedTag = await request('anki/tags/produce', undefined, {}, 'DELETE');
  assert.equal(deletedTag.payload.deleted, 'produce');
  assert.deepEqual((await request('anki/tags?all=true', undefined, {}, 'GET')).payload.tags, ['food']);

  const moved = await request('anki/notes/batch', {
    action: 'changeDeck', noteIds: [firstId, secondId], deck: 'Review',
  });
  assert.equal(moved.payload.result.cardCount, 2);
  const due = await request('anki/notes/batch', {
    action: 'setDueDate', noteIds: [firstId, secondId], days: '1-2',
  });
  assert.equal(due.payload.result.cardCount, 2);
  const flagged = await request('anki/notes/batch', { action: 'setFlag', noteIds: [firstId], flag: 2 });
  assert.equal(flagged.payload.result.flag, 2);
  const replaced = await request('anki/notes/batch', {
    action: 'findReplace', noteIds: [firstId, secondId], find: 'FRUIT', replace: 'produce', field: 'Meaning',
    ignoreCase: true, regularExpression: false,
  });
  assert.deepEqual(replaced.payload.result.changedNoteIds, [firstId, secondId]);
  assert.equal(replaced.payload.result.matchCount, 2);
  assert.equal((await request(`anki/notes/${firstId}`, undefined, {}, 'GET')).payload.note.fields
    .find(field => field.name === 'Meaning').value, 'a red produce');
  const regexReplaced = await request('anki/notes/batch', {
    action: 'findReplace', query: 'deck:"Basics"', find: 'green\\s+fruit', replace: 'ripe fruit', field: null,
    ignoreCase: true, regularExpression: true,
  });
  assert.deepEqual(regexReplaced.payload.result.changedNoteIds, [basic.payload.note.id]);
  assert.equal(regexReplaced.payload.result.matchCount, 1);
  assert.equal((await request(`anki/notes/${basic.payload.note.id}`, undefined, {}, 'GET')).payload.note.fields
    .find(field => field.name === 'Back').value, 'a ripe fruit');
  assert.equal((await request('anki/notes/batch', {
    action: 'findReplace', noteIds: [firstId], find: '(', replace: '', field: null,
    ignoreCase: true, regularExpression: true,
  })).status, 400);
  assert.equal((await request('anki/notes/batch', {
    action: 'findReplace', noteIds: [firstId], find: 'produce', replace: 'fruit', field: 'Unknown',
    ignoreCase: true, regularExpression: false,
  })).status, 400);
  const oversizedBatch = await request('anki/notes/batch', {
    action: 'setFlag',
    noteIds: [firstId, ...Array.from({ length: 500 }, (_, index) => 900000000 + index)],
    flag: 2,
  });
  assert.equal(oversizedBatch.status, 404);
  assert.match(oversizedBatch.payload.error, /Note 900000000 was not found/);

  const copied = await request(`anki/notes/${firstId}/copy`);
  assert.equal(copied.status, 201);
  const all = await request('anki/notes?query=deck:%22Review%22&select=id', undefined, {}, 'GET');
  assert.equal(all.payload.total, 3);

  assert.equal((await request(`anki/notes/${firstId}`, { fields: { Term: 'x' } },
    { Origin: 'https://untrusted.example' }, 'PUT')).status, 403);
  assert.equal((await request(`anki/notes/${firstId}`, { fields: { Term: 'x' } },
    { 'Content-Type': 'text/plain' }, 'PUT')).status, 415);
  const invalidDue = await request('anki/notes/batch', {
    action: 'setDueDate', noteIds: [firstId], days: '3-1',
  });
  assert.equal(invalidDue.status, 400);

  assert.equal((await request(`anki/notes/${secondId}`, undefined, {}, 'DELETE')).status, 200);
  assert.equal((await request(`anki/notes/${secondId}`, undefined, {}, 'GET')).status, 404);
});
