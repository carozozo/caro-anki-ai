const test = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeSearchValue, groupEntries, moveGroupOrder, namedEntry, normalizeGroupOrder, searchPrefixes,
  visibleDeckNames,
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

test('uses the selected deck list when one is configured', () => {
  const decks = ['Default', 'English', 'Idioms'];
  assert.deepEqual(visibleDeckNames(decks, { visibleDecks: ['Idioms', 'Missing', 'English'] }),
    ['English', 'Idioms']);
  assert.deepEqual(visibleDeckNames(decks, { visibleDecks: [] }), decks);
});

test('quick-search escapes dynamic Anki search values', () => {
  assert.equal(escapeSearchValue('a_*"\\&<>'), 'a\\_\\*\\"\\\\&amp;&lt;&gt;');
  assert.deepEqual(namedEntry({ prefix: 'tag', quote: true }, 'none_*'), {
    text: 'none_*', query: 'tag:"none\\_\\*"',
  });
});

test('search-prefix picker derives every prefix from quick-search groups', () => {
  assert.deepEqual(searchPrefixes([
    { values: [{ query: 'added:1' }, { query: 'rated:7' }] },
    { prefix: 'deck' }, { prefix: 'tag' }, { values: [{ query: 'added:7' }] },
  ]), ['added', 'rated', 'deck', 'tag']);
});
