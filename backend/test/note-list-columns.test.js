const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_ACTIVE_KEYS, NATIVE_COLUMNS, NOTE_LIST_FIELDS, NOTE_ROW_READ_FIELDS, NUMERIC_FIELDS, PINNED_KEYS,
  allColumns, candidateFieldNames, columnForField, columnForKey, fieldColumns, fieldOf, moveColumn,
  normalizeActiveKeys,
} = require('../../frontend/scripts/anki/note-list-columns');
const { NOTE_SEARCH_COLUMNS } = require('../anki-browser');

// The collection the browser points at, spelled the way two note types spell it: `Term`/`Meaning` for the
// English note type, `Front`/`Back` for Basic. The roster's second group is their deduplicated union.
const MODEL_FIELDS = ['Front', 'Back', 'Term', 'Meaning'];
const keysOf = fieldNames => allColumns(fieldNames).map(column => column.key);
// Anki's own columns, in the order the roster lists them — every one of them is available to the table.
const NATIVE_KEYS = ['index', 'note-type', 'deck', 'tags', 'sort-field', 'created', 'due', 'interval', 'ease',
  'reps', 'lapses', 'flag'];
// What a table that has never been touched opens with: the note's own facts and none of the scheduling numbers.
const DEFAULT_KEYS = ['index', 'note-type', 'deck', 'tags', 'created', 'due', 'flag'];
const ACTIVE_WITH_FIELD = [...DEFAULT_KEYS, 'field:Term'];

// A row is built from the list search's fields, and refreshed through a single-note read: that read answers
// `fields` instead of the row's derived `fieldValues`, and it must ask for every other listed column. Dropping
// one (Created) blanked that column until the page was reloaded.
test('the row refresh read asks for every column the list displays', () => {
  const narrow = NOTE_LIST_FIELDS.filter(field => field !== 'fieldValues');
  assert.deepEqual(NOTE_ROW_READ_FIELDS, [...narrow, 'fields']);
  narrow.forEach(field => assert.ok(NOTE_ROW_READ_FIELDS.includes(field), `${field} is not asked for`));
});

// Field values reach a row through `fieldValues`, so every name the refresh read sends has to be one the note
// endpoint answers with, or the read is rejected as an unknown selection. The search endpoint takes the union
// of both shapes because the same read returns either one, depending on what the columns asked for.
test('the row refresh read names only fields a note read answers with', () => {
  NOTE_ROW_READ_FIELDS.forEach(field =>
    assert.ok(NOTE_SEARCH_COLUMNS.includes(field), `${field} is not a note column`));
  assert.ok(NOTE_ROW_READ_FIELDS.includes('fields'));
  assert.ok(NOTE_LIST_FIELDS.includes('fieldValues'));
});

// The table sorts a scheduling number as a number, which is why the view needs to know which columns those are
// without carrying a second list of names.
test('the scheduling columns are the numeric ones, and every one of them is read', () => {
  assert.deepEqual(NUMERIC_FIELDS, ['ease', 'interval', 'reps', 'lapses']);
  NUMERIC_FIELDS.forEach(field => assert.ok(NOTE_LIST_FIELDS.includes(field), `${field} is not read`));
});

// Every Anki column the browser can show is in the roster, and only the row number is pinned: it is how a row is
// counted rather than a fact about the note, so it leads the table and cannot be taken off it or moved.
test('offers Anki\u2019s own columns, with the row number pinned first', () => {
  assert.deepEqual(keysOf([]), NATIVE_KEYS);
  assert.deepEqual(PINNED_KEYS, ['index']);
  assert.deepEqual(NATIVE_COLUMNS.filter(column => !column.reorderable).map(column => column.key), ['index']);
  // A default table opens on the note and its card, and asks for no field of its own: which fields a note type
  // has is the collection's fact, so no field column is this app's default.
  assert.deepEqual(DEFAULT_ACTIVE_KEYS, DEFAULT_KEYS);
  assert.deepEqual(DEFAULT_ACTIVE_KEYS.filter(key => key.startsWith('field:')), []);
  // A native column is not a note type field, so it carries no field name to read a note's own content from.
  assert.deepEqual(NATIVE_COLUMNS.map(fieldOf).filter(Boolean), []);
});

// A field column carries the note type's own field name, exactly as the collection spells it, and it waits in
// the roster's field group rather than among Anki's columns. A note type without the field answers nothing for
// that note rather than losing the row, which is what lets one table show a collection of mixed note types.
test('builds one column per note type field, named as the collection spells it', () => {
  assert.deepEqual(keysOf(['Term', 'Meaning']), [...NATIVE_KEYS, 'field:Term', 'field:Meaning']);
  const fieldColumnsOf = fieldNames => allColumns(fieldNames).filter(column => column.isField);
  assert.deepEqual(fieldColumnsOf(['Term', 'Meaning']).map(fieldOf), ['Term', 'Meaning']);
  assert.deepEqual(fieldColumnsOf(['Term', 'Meaning']).map(column => column.label), ['Term', 'Meaning']);
  assert.equal(fieldColumns(allColumns(['Term', 'Meaning'])), 2);
  assert.equal(fieldColumns(allColumns([])), 0);
  // A field column is available like any other, and the row number is the only column that is not.
  assert.deepEqual(fieldColumnsOf(['Term']).map(column => column.reorderable), [true]);
});

// A column is looked up by its key while the table is painted, and the first paint happens before the
// collection's fields are known: a field column that could not be resolved then was dropped from that paint and
// appeared a moment after Anki's own columns. Its key names its field, so it resolves on its own.
test('a column resolves from its own key before the collection\u2019s fields are known', () => {
  assert.deepEqual(columnForKey('field:Term'), columnForField('Term'));
  assert.deepEqual(columnForKey('field:Term').key, 'field:Term');
  assert.deepEqual(columnForKey('deck'), NATIVE_COLUMNS.find(column => column.key === 'deck'));
  assert.equal(columnForKey('gone'), undefined);
  assert.equal(columnForKey('field:'), undefined);
  // The column every key resolves to is the same one the roster builds from the collection's own spelling.
  MODEL_FIELDS.forEach(name =>
    assert.deepEqual(columnForKey(`field:${name}`), allColumns([name]).find(column => column.isField)));
});

// The roster's field group is every field name any note type in the collection has, deduplicated the way Anki
// labels them: case-insensitively, the first spelling winning.
test('offers the collection\u2019s field names as the roster\u2019s field group', () => {
  assert.deepEqual(candidateFieldNames(MODEL_FIELDS), MODEL_FIELDS);
  assert.deepEqual(candidateFieldNames(['Term', 'term', 'Front', 'TERM']), ['Term', 'Front']);
  assert.deepEqual(candidateFieldNames(['', null, 'Term']), ['Term']);
  assert.deepEqual(candidateFieldNames(undefined), []);
});

// A stored active list is trusted only where the column still exists: a note type field the collection no longer
// has is dropped with it, a name this app no longer has is dropped too, and the row number leads whatever is
// left. A column that left the table is not recorded as switched off — it is simply not in the list, waiting in
// the roster it came from.
test('a stored active list keeps only the columns the table still has', () => {
  assert.deepEqual(normalizeActiveKeys(null, []), ['index']);
  assert.deepEqual(normalizeActiveKeys('deck', []), ['index']);
  assert.deepEqual(normalizeActiveKeys(['deck', 'deck', 'gone'], []), ['index', 'deck']);
  // The row number leads the list whatever order it was stored in.
  assert.deepEqual(normalizeActiveKeys(['flag', 'index', 'tags'], []), ['index', 'flag', 'tags']);
  // A field column survives while the collection still spells the field that way, and is compared to the
  // collection's own spelling rather than to a lower-cased copy of it.
  assert.deepEqual(normalizeActiveKeys(ACTIVE_WITH_FIELD, MODEL_FIELDS), ACTIVE_WITH_FIELD);
  assert.deepEqual(normalizeActiveKeys(ACTIVE_WITH_FIELD, MODEL_FIELDS.filter(name => name !== 'Term')),
    DEFAULT_KEYS);
  assert.deepEqual(normalizeActiveKeys([...DEFAULT_KEYS, 'field:term'], MODEL_FIELDS), DEFAULT_KEYS);
});

// The collection's fields are read after the table is built, so the stored list is normalized once before they
// are known. An unknown field list must keep a field column — judging it against an empty list is what made a
// saved field column vanish on every reload — while an empty array stays the real fact that no field exists.
test('a stored field column survives until the collection\u2019s fields are known', () => {
  assert.deepEqual(normalizeActiveKeys(ACTIVE_WITH_FIELD), ACTIVE_WITH_FIELD);
  assert.deepEqual(normalizeActiveKeys([...DEFAULT_KEYS, 'field:Term', 'field:Meaning']),
    [...DEFAULT_KEYS, 'field:Term', 'field:Meaning']);
  // A stored key this app no longer has is still dropped while the fields are unknown.
  assert.deepEqual(normalizeActiveKeys([...DEFAULT_KEYS, 'gone', 'field:Term']), ACTIVE_WITH_FIELD);
  assert.deepEqual(normalizeActiveKeys(ACTIVE_WITH_FIELD, []), DEFAULT_KEYS);
  assert.deepEqual(normalizeActiveKeys(ACTIVE_WITH_FIELD, MODEL_FIELDS), ACTIVE_WITH_FIELD);
});

// A drag splices one column beside its target and leaves every other column's own order alone, so an order the
// reader saved survives a later move instead of being re-sorted. The expectations are written out rather than
// derived, because which side of its target the source lands on is the whole of what `after` decides.
test('moves only reorderable columns around each other', () => {
  const [index, noteType, deck, tags, created, due, flag] = DEFAULT_KEYS;
  const term = 'field:Term';
  const order = [...DEFAULT_KEYS, term];

  // Dragged onto Created, the field leaves the end of the table and lands ahead of it.
  assert.deepEqual(moveColumn(order, term, created, false),
    [index, noteType, deck, tags, term, created, due, flag]);
  // Which side of its target the source lands on is the whole of what `after` decides.
  assert.deepEqual(moveColumn(order, tags, due, false),
    [index, noteType, deck, created, tags, due, flag, term]);
  assert.deepEqual(moveColumn(order, tags, due, true),
    [index, noteType, deck, created, due, tags, flag, term]);
  // The row number is neither a source nor a target: it stays where it is whatever is dragged onto it.
  assert.deepEqual(moveColumn(order, index, flag, false), order);
  assert.deepEqual(moveColumn(order, flag, index, false), order);
  // A column that is not on the table is not there to be moved, and nothing moves onto itself.
  assert.deepEqual(moveColumn(order, 'field:Gone', deck, false), order);
  assert.deepEqual(moveColumn(order, deck, deck, false), order);
});
