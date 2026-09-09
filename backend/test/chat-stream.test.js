const test = require('node:test');
const assert = require('node:assert/strict');

const { streamChat, STREAM_CONTENT_TYPE } = require('../chat-stream');

const fakeResponse = () => {
  const listeners = new Map();
  const res = {
    chunks: [],
    statusCode: null,
    headers: null,
    writableEnded: false,
    writeHead (status, headers) { res.statusCode = status; res.headers = headers; },
    write (chunk) { res.chunks.push(chunk); return true; },
    end () { res.writableEnded = true; },
    on (name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
      return res;
    },
    emit (name) { (listeners.get(name) || []).forEach(handler => handler()); },
  };
  return res;
};

const eventsOf = res => res.chunks.join('').split('\n').filter(Boolean).map(line => JSON.parse(line));

test('streams each event and ends with the result payload', async () => {
  const res = fakeResponse();
  const payload = { ok: true, content: 'done', operations: [] };
  const outcome = await streamChat(res, async emit => {
    emit({ type: 'tool', operation: { action: { name: 'search_notes' }, status: 'pending' } });
    emit({ type: 'tool', operation: { action: { name: 'search_notes' }, status: 'completed', result: { total: 2 } } });
    return payload;
  });
  assert.equal(outcome.streamed, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], STREAM_CONTENT_TYPE);
  assert.equal(res.writableEnded, true);
  assert.deepEqual(eventsOf(res), [
    { type: 'tool', operation: { action: { name: 'search_notes' }, status: 'pending' } },
    { type: 'tool', operation: { action: { name: 'search_notes' }, status: 'completed', result: { total: 2 } } },
    { type: 'result', payload },
  ]);
});

test('a run that fails before its first event answers with a status code, not a stream', async () => {
  const res = fakeResponse();
  const error = Object.assign(new Error('Anki Agent is disabled'), { statusCode: 503 });
  const outcome = await streamChat(res, async () => { throw error; });
  assert.equal(outcome.streamed, false);
  assert.equal(outcome.error, error);
  assert.equal(res.statusCode, null);
  assert.deepEqual(res.chunks, []);
  assert.equal(res.writableEnded, false);
});

test('a run that fails after its first event reports it inside the stream', async () => {
  const res = fakeResponse();
  const outcome = await streamChat(res, async emit => {
    emit({ type: 'tool', operation: { action: { name: 'delete_note' }, status: 'pending' } });
    throw Object.assign(new Error('Note not found'), { statusCode: 404 });
  });
  assert.equal(outcome.streamed, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.writableEnded, true);
  assert.deepEqual(eventsOf(res).at(-1), { type: 'error', error: 'Note not found', statusCode: 404 });
});

test('a refusal carries the code that says whether its turn started', async () => {
  const res = fakeResponse();
  const outcome = await streamChat(res, async emit => {
    emit({ type: 'phase', phase: 'thinking', step: 1 });
    throw Object.assign(new Error('Another AI operation is running'), { statusCode: 409, code: 'not_started' });
  });
  assert.equal(outcome.streamed, true);
  assert.deepEqual(eventsOf(res).at(-1),
    { type: 'error', error: 'Another AI operation is running', statusCode: 409, code: 'not_started' });
});

test('a disconnected client stops receiving events without cancelling the run', async () => {
  const res = fakeResponse();
  let finished = false;
  const outcome = await streamChat(res, async emit => {
    emit({ type: 'tool', operation: { action: { name: 'create_notes' }, status: 'pending' } });
    res.emit('close');
    finished = true;
    emit({ type: 'tool', operation: { action: { name: 'create_notes' }, status: 'completed', result: {} } });
    return { ok: true };
  });
  assert.equal(finished, true);
  assert.equal(outcome.streamed, true);
  assert.deepEqual(eventsOf(res), [
    { type: 'tool', operation: { action: { name: 'create_notes' }, status: 'pending' } },
  ]);
  assert.equal(res.writableEnded, false);
});
