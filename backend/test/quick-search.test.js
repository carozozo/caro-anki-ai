const test = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeSearchValue, groupEntries, moveGroupOrder, namedEntry, normalizeGroupOrder,
} = require('../../frontend/scripts/anki/quick-search');

const GROUPS = [
  { id: 'recent' }, { id: 'card-state' }, { id: 'flags' }, { id: 'note-types' }, { id: 'decks' }, { id: 'tags' },
];

test('quick-search restores valid custom group order and appends new groups', () => {
  assert.deepEqual(normalizeGroupOrder(['flags', 'missing', 'recent', 'flags'], GROUPS), [
    'flags', 'recent', 'card-state', 'note-types', 'decks', 'tags',
  ]);
});

test('quick-search moves a group before or after its drop target', () => {
  assert.deepEqual(moveGroupOrder(['recent', 'state', 'flags'], 'flags', 'recent'), ['flags', 'recent', 'state']);
  assert.deepEqual(moveGroupOrder(['recent', 'state', 'flags'], 'recent', 'flags', true), ['state', 'flags', 'recent']);
});

test('quick-search shows dynamic names without their query prefixes', () => {
  assert.deepEqual(namedEntry({ prefix: 'note', quote: true }, 'English'), {
    text: 'English', query: 'note:"English"',
  });
  assert.deepEqual(groupEntries({ source: 'tags', prefix: 'tag', quote: true }, [], [], ['food']), [
    { text: 'food', query: 'tag:"food"' },
  ]);
});

test('quick-search escapes dynamic Anki search values', () => {
  assert.equal(escapeSearchValue('a_*"\\&<>'), 'a\\_\\*\\"\\\\&amp;&lt;&gt;');
  assert.deepEqual(namedEntry({ prefix: 'tag', quote: true }, 'none_*'), {
    text: 'none_*', query: 'tag:"none\\_\\*"',
  });
});
