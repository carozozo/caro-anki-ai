const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fieldRule,
  previewDocument,
  previewKeyboardEventType,
} = require('../../frontend/scripts/anki/card-document');

// A note type's settings for one field reach the field's own document, after the card shell, so this rule is what a
// field's font, size and direction are made of — and the font name is the one value that reaches a stylesheet.

test('states a field font, size and direction in one rule', () => {
  assert.equal(fieldRule({ font: 'Georgia', size: 24, rtl: true }),
    'font-family: Georgia; font-size: 24px; direction: rtl; text-align: right;');
});

test('keeps only what a font family may be written with', () => {
  assert.equal(fieldRule({ font: 'Bad}body{display:none' }), 'font-family: Badbodydisplaynone;');
  assert.equal(fieldRule({ font: '"Font Awesome 6", serif' }), 'font-family: Font Awesome 6, serif;');
});

test('states nothing a field does not set', () => {
  assert.equal(fieldRule({}), '');
  assert.equal(fieldRule(), '');
  assert.equal(fieldRule({ size: 0, font: '', rtl: false }), '');
});

test('names the event that an isolated preview uses to relay shortcuts', () => {
  assert.equal(previewKeyboardEventType, 'anki-card-preview-keydown');
});

test('an isolated preview relays primary-modifier and Escape key events', () => {
  const hadDocument = Object.hasOwn(global, 'document');
  const hadGetComputedStyle = Object.hasOwn(global, 'getComputedStyle');
  const { document: previousDocument, getComputedStyle: previousGetComputedStyle } = global;
  global.document = { documentElement: {} };
  global.getComputedStyle = () => ({ getPropertyValue: () => '' });
  try {
    const html = previewDocument({ html: '', scriptSrc: '/vendor/jquery.js' });
    assert.match(html, /addEventListener\('keydown'/);
    assert.match(html, /parent\.postMessage/);
    assert.match(html, /anki-card-preview-keydown/);
  } finally {
    if (hadDocument) global.document = previousDocument;
    else delete global.document;
    if (hadGetComputedStyle) global.getComputedStyle = previousGetComputedStyle;
    else delete global.getComputedStyle;
  }
});
