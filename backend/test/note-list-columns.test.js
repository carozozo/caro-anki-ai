const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NOTE_COLUMNS, NOTE_LIST_FIELDS, NOTE_ROW_READ_FIELDS, moveColumn, normalizeColumnOrder,
} = require('../../frontend/scripts/anki/note-list-columns');
const { NOTE_COLUMNS: NOTE_ROW_COLUMNS } = require('../anki-browser');

// A row is built from the list search's fields, and refreshed through a single-note read: that read answers
// `fields` instead of the derived `term`/`meaning`, and it must ask for every other listed column. Dropping
// one (Created) blanked that column until the page was reloaded.
test('the row refresh read asks for every column the list displays', () => {
  const derived = NOTE_LIST_FIELDS.filter(field => field !== 'term' && field !== 'meaning');
  assert.deepEqual(NOTE_ROW_READ_FIELDS, [...derived, 'fields', 'sortField']);
  derived.forEach(field => assert.ok(NOTE_ROW_READ_FIELDS.includes(field), `${field} is not asked for`));
});

// `term` and `meaning` reach a row through `fields`, so every name the refresh read sends has to be one the
// note endpoint answers with, or the read is rejected as an unknown selection.
test('the row refresh read names only fields a note read answers with', () => {
  NOTE_ROW_READ_FIELDS.forEach(field =>
    assert.ok(NOTE_ROW_COLUMNS.includes(field), `${field} is not a note column`));
  assert.ok(NOTE_ROW_READ_FIELDS.includes('fields'));
});

test('normalizes persisted note-column order and keeps the index pinned first', () => {
  const defaultOrder = NOTE_COLUMNS.map(column => column.key);
  const saved = ['meaning', 'index', 'flag', 'tags', 'note-type', 'deck', 'term', 'created', 'due'];

  assert.deepEqual(normalizeColumnOrder(saved), ['index', ...saved.filter(key => key !== 'index')]);
  assert.deepEqual(normalizeColumnOrder(['index', 'flag']), defaultOrder);
  assert.deepEqual(normalizeColumnOrder([...defaultOrder.slice(0, -1), 'flag']), defaultOrder);
  assert.deepEqual(normalizeColumnOrder([...defaultOrder.slice(0, -1), 'unknown']), defaultOrder);
});

// The default arrangement is a contract of its own: it is what the table draws for a reader who has never
// dragged a column, and it is the list a saved order is validated against and restored into. Stating it here
// once is also what lets the move test below name a column instead of restating the whole arrangement.
test('draws the note columns in their default order with the index pinned first', () => {
  assert.deepEqual(NOTE_COLUMNS.map(column => column.key),
    ['index', 'tags', 'note-type', 'deck', 'term', 'meaning', 'created', 'due', 'flag']);
  assert.equal(NOTE_COLUMNS[0].reorderable, false);
});

// A drag splices one column beside its target and leaves every other column's own order alone, so an order the
// reader saved survives a later move instead of being re-sorted. The expectations are written out rather than
// derived, because which side of its target the source lands on is the whole of what `after` decides — and they
// are named off the default order above, so a deliberate rearrangement is one edit in one test, not two.
test('moves only reorderable note columns around each other', () => {
  const order = NOTE_COLUMNS.map(column => column.key);
  const [index, tags, noteType, deck, term, meaning, created, due, flag] = order;

  // Dragged onto the last column, term leaves its place among the content and lands just ahead of flag.
  assert.deepEqual(moveColumn(order, 'term', 'flag'),
    [index, tags, noteType, deck, meaning, created, due, term, flag]);
  // Dropped on the far side of term, flag lands between it and meaning rather than ahead of it.
  assert.deepEqual(moveColumn(order, 'flag', 'term', true),
    [index, tags, noteType, deck, term, flag, meaning, created, due]);
  // The index is neither a source nor a target: it stays where it is whatever is dragged onto it.
  assert.deepEqual(moveColumn(order, 'index', 'term'), order);
  assert.deepEqual(moveColumn(order, 'term', 'index'), order);
});
