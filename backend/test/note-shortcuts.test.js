const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aria, capture, definitions, display, matches, persist, resetAll, restore, sameBinding, update,
} = require('../../frontend/scripts/anki/note-shortcuts');

const shortcut = id => definitions.find(item => item.id === id);
const event = (key, modifiers = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false,
  shiftKey: false, ...modifiers });

test('defines one unique primary-modifier shortcut for every configurable action', () => {
  assert.equal(definitions.length, 37);
  const chords = definitions.map(({ key, code, shift, alt }) =>
    `${alt ? 'alt+' : ''}${shift ? 'shift+' : ''}${code || key.toLowerCase()}`);
  assert.equal(new Set(chords).size, definitions.length);
  assert.equal(shortcut('ai').key, 'g');
  assert.equal(shortcut('study-options').key, 'o');
  assert.equal(shortcut('note-type').key, 'n');
  assert.equal(shortcut('manage-decks').key, 'd');
  assert.equal(shortcut('manage-tags').key, 't');
  assert.equal(shortcut('preview').key, 'v');
  assert.deepEqual(shortcut('undo'), {
    id: 'undo', scope: 'browser', selector: '#ankiUndo', key: '[', alt: true, label: 'Undo',
  });
  assert.deepEqual(shortcut('redo'), {
    id: 'redo', scope: 'browser', selector: '#ankiRedo', key: ']', alt: true, label: 'Redo',
  });
  assert.equal(shortcut('send-chat').key, 'Enter');
});

test('matches Command on macOS and Control on Windows without extra modifiers', () => {
  assert.equal(matches(event('G', { metaKey: true }), shortcut('ai')), true);
  assert.equal(matches(event('g', { ctrlKey: true }), shortcut('ai')), true);
  assert.equal(matches(event('g', { ctrlKey: true, shiftKey: true }), shortcut('ai')), false);
  assert.equal(matches(event('g'), shortcut('ai')), false);
  assert.equal(matches(event('o', { metaKey: true, shiftKey: true }), shortcut('study-options')), true);
  assert.equal(matches(event('n', { ctrlKey: true, shiftKey: true }), shortcut('note-type')), true);
  assert.equal(matches(event('d', { metaKey: true, shiftKey: true }), shortcut('manage-decks')), true);
  assert.equal(matches(event('t', { ctrlKey: true, shiftKey: true }), shortcut('manage-tags')), true);
  assert.equal(matches(event('v', { ctrlKey: true, shiftKey: true }), shortcut('preview')), true);
  assert.equal(matches(event('q', { ctrlKey: true, altKey: true }), shortcut('toggle-quick-search')), true);
  assert.equal(matches(event('[', { metaKey: true, altKey: true, code: 'BracketLeft' }), shortcut('undo')), true);
  assert.equal(matches(event(']', { ctrlKey: true, altKey: true, code: 'BracketRight' }), shortcut('redo')), true);
});

test('matches physical Option keys when macOS changes event.key', () => {
  assert.equal(matches(event('œ', { metaKey: true, altKey: true, code: 'KeyQ' }),
    shortcut('toggle-quick-search')), true);
  assert.equal(matches(event('©', { metaKey: true, altKey: true, code: 'KeyG' }),
    shortcut('toggle-chat')), true);
});

test('matches the shifted brackets that jump to the list edges', () => {
  assert.equal(matches(event('{', { metaKey: true, shiftKey: true, code: 'BracketLeft' }),
    shortcut('first')), true);
  assert.equal(matches(event('}', { ctrlKey: true, shiftKey: true, code: 'BracketRight' }),
    shortcut('last')), true);
  assert.equal(matches(event('[', { metaKey: true, code: 'BracketLeft' }), shortcut('previous')), true);
  assert.equal(matches(event('[', { metaKey: true }), shortcut('first')), false);
  assert.equal(matches(event(']', { ctrlKey: true }), shortcut('last')), false);
});

test('formats platform-specific hints and exposes both modifiers to assistive technology', () => {
  assert.equal(display(shortcut('ai'), true), '⌘ + G');
  assert.equal(display(shortcut('undo'), true), '⌘ + Alt + [');
  assert.equal(display(shortcut('redo'), false), 'Ctrl + Alt + ]');
  assert.equal(display(shortcut('ai'), false), 'Ctrl + G');
  assert.equal(display(shortcut('first'), true), '⌘ + Shift + [');
  assert.equal(display(shortcut('study-options'), true), '⌘ + Shift + O');
  assert.equal(display(shortcut('manage-tags'), true), '⌘ + Shift + T');
  assert.equal(display(shortcut('preview'), true), '⌘ + Shift + V');
  assert.equal(aria(shortcut('ai')), 'Meta+G Control+G');
  assert.equal(aria(shortcut('undo')), 'Meta+Alt+[ Control+Alt+[');
  assert.equal(aria(shortcut('redo')), 'Meta+Alt+] Control+Alt+]');
  assert.equal(aria(shortcut('last')), 'Meta+Shift+] Control+Shift+]');
  assert.equal(aria(shortcut('study-options')), 'Meta+Shift+O Control+Shift+O');
  assert.equal(aria(shortcut('manage-tags')), 'Meta+Shift+T Control+Shift+T');
  assert.equal(aria(shortcut('preview')), 'Meta+Shift+V Control+Shift+V');
});

test('captures, persists, and restores a non-conflicting user binding', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const custom = capture(event('K', { metaKey: true, shiftKey: true, code: 'KeyK' }));
  assert.deepEqual(custom, { key: 'k', code: '', shift: true, alt: false });
  assert.equal(sameBinding(custom, shortcut('ai')), false);

  update('ai', custom);
  persist(storage, 'shortcuts');
  resetAll();
  assert.equal(matches(event('g', { metaKey: true }), shortcut('ai')), true);
  restore(storage, 'shortcuts');
  assert.equal(matches(event('k', { ctrlKey: true, shiftKey: true }), shortcut('ai')), true);
  assert.equal(display(shortcut('ai'), true), '⌘ + Shift + K');
  resetAll();
});
