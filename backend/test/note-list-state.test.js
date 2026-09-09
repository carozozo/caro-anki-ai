const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeUpdatedNotes, scrollTopForIndex, selectedNotesInOrder, selectionEntryIndex,
  updatedNoteIds, visibleRange,
} = require('../../frontend/scripts/anki/note-list-state');

test('extracts only notes successfully updated by the agent', () => {
  const operations = [
    { action: { name: 'read_notes' }, status: 'completed', result: { notes: [{ noteId: 1 }] } },
    { action: { name: 'update_notes' }, status: 'completed', result: { notes: [{ id: 2 }, { id: 4 }] } },
    { action: { name: 'update_notes' }, status: 'completed', result: { notes: [{ id: 2 }] } },
    { action: { name: 'update_notes' }, status: 'failed', result: { notes: [{ id: 3 }] } },
  ];
  assert.deepEqual(updatedNoteIds(operations), [2, 4]);
});

// A conversation persisted before the tool took a batch, or before the names were namespaced, must keep
// refreshing the browser, or an old session would silently stop showing the edits it made.
test('extracts an update persisted under an older singular name', () => {
  const operations = [
    { action: { name: 'update_note' }, status: 'completed', result: { id: 2 } },
    { action: { name: 'update' }, status: 'completed', result: { id: 7 } },
  ];
  assert.deepEqual(updatedNoteIds(operations), [2, 7]);
});

test('calculates a bounded virtual row window with overscan', () => {
  assert.deepEqual(visibleRange(20562, 4200, 420, 42, 10), { first: 90, end: 120 });
  assert.deepEqual(visibleRange(15, 0, 420, 42, 10), { first: 0, end: 15 });
});

test('keeps keyboard selection inside the viewport below the sticky header', () => {
  assert.equal(scrollTopForIndex(30, 31 * 42, 420, 42), 30 * 42);
  assert.equal(scrollTopForIndex(31, 31 * 42, 420, 42), 31 * 42);
  assert.equal(scrollTopForIndex(40, 31 * 42, 420, 42), 32 * 42);
});

test('updates displayed notes in place without filtering or reordering the current result', () => {
  const word = { id: 1, deckName: 'word', flag: 2, createdAt: '2026-01-02T00:00:00.000Z' };
  const other = { id: 2, deckName: 'word', flag: 2 };
  const notes = mergeUpdatedNotes([word, other], [{ id: 1, deckName: 'idiom', flag: 1 }]);

  assert.deepEqual(notes.map(note => note.id), [1, 2]);
  assert.equal(notes[0].deckName, 'idiom');
  assert.equal(notes[0].flag, 1);
  // A read that did not ask for a field must not blank the column it feeds.
  assert.equal(notes[0].createdAt, '2026-01-02T00:00:00.000Z');
  assert.equal(notes[1], other);
});

test('returns selected notes in selection order rather than display order', () => {
  const notes = [{ id: 1 }, { id: 2 }, { id: 3 }];

  assert.deepEqual(selectedNotesInOrder(notes, new Set([3, 1])).map(note => note.id), [3, 1]);
  assert.deepEqual(selectedNotesInOrder(notes, new Set([1, 3])).map(note => note.id), [1, 3]);
});

test('enters an unselected list at the row on screen nearest the remembered selection', () => {
  const onScreen = { first: 400, end: 431 };
  assert.equal(selectionEntryIndex(1000, 415, 'ArrowDown', onScreen), 416);
  assert.equal(selectionEntryIndex(1000, 415, 'ArrowUp', onScreen), 414);
  assert.equal(selectionEntryIndex(1000, 1, 'ArrowDown', onScreen), 400);
  assert.equal(selectionEntryIndex(1000, 1, 'ArrowUp', onScreen), 400);
  assert.equal(selectionEntryIndex(1000, 900, 'ArrowDown', onScreen), 430);
  assert.equal(selectionEntryIndex(1000, 900, 'ArrowUp', onScreen), 430);
});

test('enters a list that was never selected in at the first row on screen', () => {
  assert.equal(selectionEntryIndex(1000, null, 'ArrowDown', { first: 400, end: 431 }), 400);
  assert.equal(selectionEntryIndex(1000, null, 'ArrowUp', { first: 400, end: 431 }), 400);
  assert.equal(selectionEntryIndex(10, null, 'ArrowUp', { first: 0, end: 11 }), 0);
});

test('reports no entry row for an empty list', () => {
  assert.equal(selectionEntryIndex(0, 4, 'ArrowDown', { first: 0, end: 0 }), -1);
  assert.equal(selectionEntryIndex(0, null, 'ArrowUp', { first: 0, end: 0 }), -1);
});
