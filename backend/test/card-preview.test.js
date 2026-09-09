const test = require('node:test');
const assert = require('node:assert/strict');
const { previewIndex, previewKeyboardInit } = require('../../frontend/scripts/anki/card-preview');

const notes = [{ id: 8 }, { id: 3 }, { id: 6 }];

test('card preview defaults to the first note in the list without a selection', () => {
  assert.equal(previewIndex(notes, new Set()), 0);
});

test('card preview opens the first selected note in list order', () => {
  assert.equal(previewIndex(notes, new Set([6, 3])), 1);
  assert.equal(previewIndex(notes, new Set([6])), 2);
});

test('card preview has no target for an empty list or stale selection', () => {
  assert.equal(previewIndex([], new Set()), -1);
  assert.equal(previewIndex(notes, new Set([99])), -1);
});

test('forwards only preview shortcut and Escape keyboard events', () => {
  const type = 'anki-card-preview-keydown';
  assert.deepEqual(previewKeyboardInit({ type, key: 'V', code: 'KeyV', metaKey: true }, type), {
    bubbles: true,
    cancelable: true,
    key: 'V',
    code: 'KeyV',
    altKey: false,
    ctrlKey: false,
    metaKey: true,
    shiftKey: false,
  });
  assert.equal(previewKeyboardInit({ type, key: 'a' }, type), null);
  assert.equal(previewKeyboardInit({ type: 'other', key: 'Escape' }, type), null);
  assert.equal(previewKeyboardInit({ type, key: 'Escape' }, type).key, 'Escape');
});
