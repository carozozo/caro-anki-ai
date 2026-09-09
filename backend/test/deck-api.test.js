const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./server-process');

test('HTTP deck API creates, renames, and deletes decks', { timeout: 10000 }, async t => {
  const { port, stop } = await startServer();
  t.after(() => stop());

  const request = async (route, body, headers = {}, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json() };
  };

  assert.equal((await request('anki/decks', { name: 'Blocked' }, {
    Origin: 'https://untrusted.example',
  })).status, 403);
  assert.equal((await request('anki/decks', { name: 'Plain text' }, {
    'Content-Type': 'text/plain',
  })).status, 415);

  const created = await request('anki/decks', { name: 'Study Deck' });
  assert.equal(created.status, 201);
  assert.equal(created.payload.ok, true);
  assert.equal(created.payload.deck.name, 'Study Deck');
  await request('anki/decks', { name: 'Study Deck::Words' });
  await request('anki-settings', {
    modelName: 'English', allowDuplicate: true, visibleDecks: ['Study Deck', 'Study Deck::Words', '_Todo'],
  }, {}, 'PUT');

  assert.equal((await request('anki/decks/Study%20Deck', { name: 'Blocked rename' }, {
    Origin: 'https://untrusted.example',
  }, 'PUT')).status, 403);
  assert.equal((await request('anki/decks/Study%20Deck', { name: 'Plain text rename' }, {
    'Content-Type': 'text/plain',
  }, 'PUT')).status, 415);

  const renamed = await request('anki/decks/Study%20Deck', { name: 'Review Deck' }, {}, 'PUT');
  assert.deepEqual(renamed, {
    status: 200,
    payload: { ok: true, deck: { oldName: 'Study Deck', name: 'Review Deck' } },
  });
  assert.deepEqual((await request('anki-settings', undefined, {}, 'GET')).payload.visibleDecks,
    ['Review Deck', 'Review Deck::Words', '_Todo']);

  assert.equal((await request('anki/decks/Review%20Deck', undefined, {
    Origin: 'https://untrusted.example',
  }, 'DELETE')).status, 403);
  const deleted = await request('anki/decks/Review%20Deck', undefined, {}, 'DELETE');
  assert.deepEqual(deleted, { status: 200, payload: { ok: true, deleted: 'Review Deck' } });
  assert.deepEqual((await request('anki-settings', undefined, {}, 'GET')).payload.visibleDecks, ['_Todo']);
});
