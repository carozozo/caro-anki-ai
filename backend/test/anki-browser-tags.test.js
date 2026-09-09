const test = require('node:test');
const assert = require('node:assert/strict');
const { AnkiBrowser } = require('../anki-browser');

const tagNames = Array.from({ length: 501 }, (_, index) => `tag-${String(index).padStart(3, '0')}`);
const browser = new AnkiBrowser({
  client: { invoke: async action => {
    assert.equal(action, 'getTags');
    return tagNames;
  } },
  config: {},
});

test('tag listing returns every tag when a collection browser requests them all', async () => {
  const all = await browser.tags({ all: true });
  const limited = await browser.tags({ limit: 500 });

  assert.equal(all.total, 501);
  assert.equal(all.tags.length, 501);
  assert.equal(limited.tags.length, 500);
});
