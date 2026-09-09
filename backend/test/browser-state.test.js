const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, read, write } = require('../../frontend/scripts/core/browser-state');

const fakeStorage = (initial = null) => {
  let value = initial;
  return { getItem: () => value, setItem: (_key, next) => { value = next; }, stored: () => value };
};

const DEFAULT_VIEW = {
  query: '', sortField: 'createdAt', sortDirection: 'desc', scrollTop: 0, selectedIds: [],
  activeId: null, editorOpen: false, collapsedGroups: [], quickSearchGroupOrder: [], sessionId: null,
};

test('reads a missing or corrupt record as the default view', () => {
  assert.deepEqual(normalize(null), DEFAULT_VIEW);
  assert.deepEqual(read(fakeStorage('{not json'), 'view'), DEFAULT_VIEW);
});

test('replaces only the fields it cannot trust', () => {
  assert.deepEqual(normalize({
    query: 'deck:_Todo', sortField: 42, sortDirection: 'sideways', scrollTop: -5,
    selectedIds: ['7', 7, 'x', null, 3.5], activeId: '12', editorOpen: true,
    collapsedGroups: ['FLAGS', 'FLAGS', 4, ''], quickSearchGroupOrder: ['flags', 'flags', 4, ''],
    sessionId: 9,
  }), {
    query: 'deck:_Todo', sortField: 'createdAt', sortDirection: 'desc', scrollTop: 0,
    selectedIds: [7], activeId: 12, editorOpen: true, collapsedGroups: ['FLAGS'],
    quickSearchGroupOrder: ['flags'], sessionId: null,
  });
});

// Which fields a collection has is the collection's own to decide, so any name the app could have sorted by is
// kept rather than replaced with the default behind the user's back.
test('keeps a sort field the collection could have, and replaces one that is not a name', () => {
  assert.equal(normalize({ sortField: 'deckName' }).sortField, 'deckName');
  assert.equal(normalize({ sortField: 'Examples' }).sortField, 'Examples');
  assert.equal(normalize({ sortField: 'nonsense' }).sortField, 'nonsense');
  assert.equal(normalize({ sortField: 'dueAt', sortDirection: 'asc' }).sortField, 'dueAt');
  assert.equal(normalize({ sortField: 'dueAt', sortDirection: 'asc' }).sortDirection, 'asc');
  assert.equal(normalize({ sortField: 42 }).sortField, 'createdAt');
  assert.equal(normalize({ sortField: 'x'.repeat(65) }).sortField, 'createdAt');
});

test('keeps an editor restorable only while it has a note to reopen', () => {
  assert.equal(normalize({ editorOpen: true, activeId: null }).editorOpen, false);
  assert.equal(normalize({ editorOpen: true, activeId: 3 }).editorOpen, true);
  assert.equal(normalize({ editorOpen: 'yes', activeId: 3 }).editorOpen, false);
});

test('rounds a fractional scroll position', () => {
  assert.equal(normalize({ scrollTop: 421.6 }).scrollTop, 422);
});

test('merges a patch over the stored record instead of replacing it', () => {
  const storage = fakeStorage();
  write(storage, 'view', {
    query: 'flag:2', selectedIds: [3, 1], collapsedGroups: ['ADDED'],
    quickSearchGroupOrder: ['flags', 'recent'],
  });
  const next = write(storage, 'view', { sessionId: 'abc' });

  assert.equal(next.query, 'flag:2');
  assert.deepEqual(next.selectedIds, [3, 1]);
  assert.deepEqual(next.collapsedGroups, ['ADDED']);
  assert.deepEqual(next.quickSearchGroupOrder, ['flags', 'recent']);
  assert.equal(next.sessionId, 'abc');
  assert.deepEqual(read(storage, 'view'), next);
});
