const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./server-process');

test('HTTP export flow requires JSON, origin and confirmation, then persists local note IDs',
  { timeout: 10000 }, async t => {
  const { port, stop } = await startServer({ CARO_APP_VARIANT: 'dev' });
  t.after(() => stop());
  const html = await (await fetch(`http://127.0.0.1:${port}`)).text();
  assert.match(html, /<title>Caro Anki Dev<\/title>/);
  assert.doesNotMatch(html, /\{\{APP_TITLE\}\}/);
  const request = async (route, body, headers = {}, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json() };
  };
  const { payload: { session } } = await request('sessions', {});
  const route = `sessions/${session.id}`;
  assert.equal((await request(`${route}/chat`, { content: 'hello', requestId: 'one' },
    { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request(`${route}/chat`, { content: 'hello', requestId: 'one' },
    { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request(`${route}/chat`, { content: 'hello', requestId: 'one' })).status, 503);
  // A streaming request that fails before any work started answers with the same JSON error, so the
  // client never has to understand a half-open stream.
  assert.equal((await request(`${route}/chat`, { content: 'hello', requestId: 'two', stream: true })).status, 503);
  // Stopping a run names it, and a turn that already ended is the normal outcome of a slow click rather than
  // an error — so the route validates its request the same way every other AI route does, and then answers
  // that nothing was there to stop.
  assert.equal((await request('agent/cancel', { requestId: 'one' },
    { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('agent/cancel', { requestId: 'one' },
    { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request('agent/cancel', {})).status, 400);
  const cancel = await request('agent/cancel', { requestId: 'no-such-run' });
  assert.deepEqual(cancel, { status: 200, payload: { ok: true, cancelled: false } });
  const card = { term: 'test', meaning: 'an examination', type: 'noun', typeLabel: 'C',
    translation: '測試', implications: ['考試', '測驗', '檢查'], phonetic: '/test/',
    examples: Array.from({ length: 3 }, () => ({ en: 'Take a test.', zh: '參加測驗。' })) };
  const saved = await request(`${route}/cards`, { cards: [card] }, {}, 'PUT');
  assert.equal(saved.status, 200);
  const second = await request(`${route}/cards`, { cards: [{ ...card, term: 'second' }] }, {}, 'PUT');
  const third = await request(`${route}/cards`, { cards: [{ ...card, term: 'third' }] }, {}, 'PUT');
  const restored = await request(`${route}/cards`, { cards: [{ ...card, translation: '舊版已修改' }] }, {}, 'PUT');
  assert.equal(restored.payload.cardVersion.version_number, 4);
  const sessionPayload = await request(route, undefined, {}, 'GET');
  assert.deepEqual(sessionPayload.payload.cardVersions.map(version => version.id), [
    restored.payload.cardVersion.id,
    third.payload.cardVersion.id,
    second.payload.cardVersion.id,
    saved.payload.cardVersion.id,
  ]);
  assert.equal(sessionPayload.payload.cardVersions[2].cards[0].translation, '測試');
  const previewBody = { cardVersionId: restored.payload.cardVersion.id, cardIndex: 0 };
  assert.equal((await request(`${route}/anki-preview`, previewBody,
    { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request(`${route}/anki-preview`, previewBody,
    { Origin: 'https://untrusted.example' })).status, 403);
  const preview = await request(`${route}/anki-preview`, previewBody);
  assert.equal(preview.status, 200);
  assert.equal(preview.payload.export.cardIndex, 0);
  const exportId = preview.payload.export.id;
  assert.equal((await request(`${route}/anki-add`, { exportId })).status, 400);
  const result = await request(`${route}/anki-add`, { exportId, confirmed: true });
  assert.equal(result.payload.export.status, 'completed');
  assert.equal(result.payload.export.noteIds.length, 1);
  assert.ok(Number.isSafeInteger(result.payload.export.noteIds[0]));
  await request(`${route}/anki-add`, { exportId, confirmed: true });
  const savedNote = await request(`anki/notes/${result.payload.export.noteIds[0]}`, undefined, {}, 'GET');
  assert.equal(savedNote.payload.note.fields.find(field => field.name === '詞彙').value, 'test');
  const history = await request(`${route}/anki-exports`, undefined, {}, 'GET');
  assert.equal(history.payload.exports[0].status, 'completed');
  const lonely = (await request('sessions', {})).payload.session;
  assert.equal((await request(`sessions/${lonely.id}`, undefined,
    { Origin: 'https://untrusted.example' }, 'DELETE')).status, 403);
  const removed = await request(`sessions/${lonely.id}`, undefined, {}, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal(removed.payload.deleted, 1);
  assert.equal((await request(`sessions/${lonely.id}`, undefined, {}, 'DELETE')).status, 404);
  assert.equal((await request(`sessions/${lonely.id}`, undefined, {}, 'GET')).status, 404);
  assert.equal((await request(route, undefined, {}, 'GET')).status, 200);
});
