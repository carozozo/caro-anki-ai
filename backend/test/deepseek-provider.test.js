const test = require('node:test');
const assert = require('node:assert/strict');

const { DeepSeekProvider, parseJsonResponse } = require('../providers/deepseek-provider');

const withFetch = async (responses, run) => {
  const original = globalThis.fetch;
  let count = 0;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const response = responses[Math.min(count++, responses.length - 1)];
    if (response instanceof Error) throw response;
    // A factory hands the same stubbed failure to every attempt with a fresh response each time.
    return typeof response === 'function' ? response() : response;
  };
  try { await run(() => count, bodies); } finally { globalThis.fetch = original; }
};

const ok = (finishReason, content, reasoningTokens) => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ finish_reason: finishReason, message: { content } }],
    usage: { completion_tokens_details: { reasoning_tokens: reasoningTokens } },
  }),
});
const calls = (finishReason, toolCalls, content = '') => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ finish_reason: finishReason, message: { content, tool_calls: toolCalls } }],
    usage: { completion_tokens_details: { reasoning_tokens: 0 } },
  }),
});
const failed = status => ({ ok: false, status, text: async () => 'boom' });
const message = content => ({ messages: [{ role: 'user', content }] });
const tool = (name, args, id = 'call_1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const sse = events => ({
  ok: true,
  status: 200,
  body: new ReadableStream({
    start (controller) {
      const encoder = new TextEncoder();
      events.forEach(event => controller.enqueue(
        encoder.encode(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)));
      controller.close();
    },
  }),
});
// A body that sends what it has and then stays open, which is what a stalled reply looks like.
const stalledSse = events => ({
  ok: true,
  status: 200,
  body: new ReadableStream({
    start (controller) {
      const encoder = new TextEncoder();
      events.forEach(event => controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(event)}\n\n`)));
    },
  }),
});
// The same events, spaced out, so the reply is slow without ever going quiet.
const dripSse = (events, gapMs) => ({
  ok: true,
  status: 200,
  body: new ReadableStream({
    start (controller) {
      const encoder = new TextEncoder();
      events.forEach((event, index) => setTimeout(() => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        if (index === events.length - 1) controller.close();
      }, gapMs * (index + 1)));
    },
  }),
});

test('parses a structured DeepSeek response', () => {
  assert.deepEqual(parseJsonResponse('{"cards":[]}'), { cards: [] });
});

test('rejects empty and invalid DeepSeek responses', () => {
  assert.throws(() => parseJsonResponse(''), /empty content/);
  assert.throws(() => parseJsonResponse('not json'), /invalid JSON/);
  assert.throws(() => parseJsonResponse('{"action":'), /invalid JSON/);
});

test('repairs an envelope truncated by its final brace', () => {
  const truncated = '{"content":"x","action":{"name":"create","args":{"cards":[{"term":"a"}]}}';
  assert.equal(parseJsonResponse(truncated).action.name, 'create');
});

test('keeps the real action when DeepSeek appends a trailing ",action":null', () => {
  const hybrid = '{"content":"x","action":{"name":"create","args":{"cards":[]}},"action":null}';
  assert.equal(parseJsonResponse(hybrid).action.name, 'create');
});

test('ignores code fences and text after the envelope', () => {
  assert.deepEqual(parseJsonResponse('```json\n{"cards":[]}\n```'), { cards: [] });
  assert.deepEqual(parseJsonResponse('{"cards":[]} done'), { cards: [] });
});

test('retries an unparsable completion because no action was produced yet', async () => {
  await withFetch([ok('length', '', 16000), ok('stop', '{"cards":[]}', 12)], async calls => {
    const provider = new DeepSeekProvider({ apiKey: 'test' });
    assert.deepEqual(await provider.completeJson(message('hi')), { cards: [] });
    assert.equal(calls(), 2);
  });
});

test('reports the finish reason when every attempt is unparsable', async () => {
  await withFetch([ok('length', '', 16000)], async () => {
    const provider = new DeepSeekProvider({ apiKey: 'test' });
    await assert.rejects(
      provider.completeJson(message('hi')),
      /empty content \(finish_reason: length, reasoning_tokens: 16000\)/,
    );
  });
});

test('retries a transport failure and a retryable HTTP status', async () => {
  await withFetch([Object.assign(new Error('fetch failed'), { cause: new Error('ENOTFOUND') }), ok('stop', '{}', 1)], async calls => {
    const provider = new DeepSeekProvider({ apiKey: 'test' });
    assert.deepEqual(await provider.completeJson(message('hi')), {});
    assert.equal(calls(), 2);
  });
  await withFetch([failed(503), ok('stop', '{}', 1)], async calls => {
    const provider = new DeepSeekProvider({ apiKey: 'test' });
    await provider.completeJson(message('hi'));
    assert.equal(calls(), 2);
  });
});

test('does not retry an HTTP client error', async () => {
  await withFetch([failed(400)], async calls => {
    const provider = new DeepSeekProvider({ apiKey: 'test' });
    await assert.rejects(provider.completeJson(message('hi')), /DeepSeek API error: 400/);
    assert.equal(calls(), 1);
  });
});

test('tool mode omits response_format and normalizes every tool call', async () => {
  const tools = [{ type: 'function', function: { name: 'create', parameters: {} } }];
  await withFetch([calls('tool_calls', [tool('create', { cards: [] })], '為你建立卡片')], async (_count, bodies) => {
    const provider = new DeepSeekProvider({ apiKey: 'test' });
    const reply = await provider.completeWithTools({ messages: message('hi').messages, tools });
    assert.deepEqual(reply.toolCalls, [{ id: 'call_1', name: 'create', args: { cards: [] } }]);
    assert.equal(reply.content, '為你建立卡片');
    assert.equal(bodies[0].response_format, undefined);
    assert.deepEqual(bodies[0].tools, tools);
    assert.equal(bodies[0].reasoning_effort, 'high');
  });
});

test('a per-call reasoning effort overrides the provider default', async () => {
  await withFetch([calls('tool_calls', [tool('create', { cards: [] })])], async (_count, bodies) => {
    const provider = new DeepSeekProvider({ apiKey: 'test' });
    await provider.completeWithTools({ messages: message('hi').messages, tools: [{}], reasoningEffort: 'low' });
    assert.equal(bodies[0].reasoning_effort, 'low');
  });
});

test('an `auto` profile effort is never sent to the API', async () => {
  await withFetch([calls('tool_calls', [tool('create', { cards: [] })])], async (_count, bodies) => {
    const provider = new DeepSeekProvider({ apiKey: 'test', reasoningEffort: 'auto' });
    await provider.completeWithTools({ messages: message('hi').messages, tools: [{}] });
    assert.equal(bodies[0].reasoning_effort, 'high');
  });
});

// Thinking and the answer share one budget, so any `max_tokens` we picked ourselves would cap a thinking
// turn's deliberation and leave it empty. The API's per-mode default is what has to bound the reply.
test('never sends max_tokens, in either mode', async () => {
  await withFetch([ok('stop', '{}', 1)], async (_count, bodies) => {
    await new DeepSeekProvider({ apiKey: 'test' }).completeJson(message('hi'));
    assert.equal('max_tokens' in bodies[0], false);
  });
  await withFetch([calls('tool_calls', [tool('read', { id: 1 })])], async (_count, bodies) => {
    await new DeepSeekProvider({ apiKey: 'test' })
      .completeWithTools({ messages: message('hi').messages, tools: [{}] });
    assert.equal('max_tokens' in bodies[0], false);
  });
});

test('never sends max_tokens on a side call either', async () => {
  await withFetch([ok('stop', '{"effort":"low"}', 0)], async (_count, bodies) => {
    await new DeepSeekProvider({ apiKey: 'test' })
      .completeJson({ messages: message('hi').messages, reasoningEffort: 'none', attempts: 1 });
    assert.equal('max_tokens' in bodies[0], false);
  });
});

test('a side call can override the model and turn thinking off', async () => {
  await withFetch([ok('stop', '{"effort":"low"}', 0)], async (_count, bodies) => {
    const provider = new DeepSeekProvider({ apiKey: 'test', model: 'deepseek-v4-flash' });
    const reply = await provider.completeJson({ messages: message('hi').messages,
      model: 'deepseek-chat', reasoningEffort: 'none', attempts: 1 });
    assert.deepEqual(reply, { effort: 'low' });
    assert.equal(bodies[0].model, 'deepseek-chat');
    assert.equal(bodies[0].reasoning_effort, 'none');
    assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
  });
});

test('a side call with one attempt is not retried', async () => {
  await withFetch([failed(503)], async calls => {
    const provider = new DeepSeekProvider({ apiKey: 'test' });
    await assert.rejects(provider.completeJson({ messages: message('hi').messages, attempts: 1 }),
      /DeepSeek API error: 503/);
    assert.equal(calls(), 1);
  });
});

test('tool mode repairs malformed arguments and retries an empty turn', async () => {
  const padded = { id: 'call_1', type: 'function', function: { name: 'read', arguments: '  {"id": 12}  ' } };
  await withFetch([calls('tool_calls', [padded])], async () => {
    const provider = new DeepSeekProvider({ apiKey: 'test' });
    const reply = await provider.completeWithTools({ messages: message('hi').messages, tools: [{}] });
    assert.deepEqual(reply.toolCalls[0].args, { id: 12 });
  });
  const truncated = { id: 'call_9', type: 'function', function: { name: 'create', arguments: '{"cards":[{"term":"a"}]' } };
  await withFetch([calls('tool_calls', [truncated])], async () => {
    const provider = new DeepSeekProvider({ apiKey: 'test' });
    const reply = await provider.completeWithTools({ messages: message('hi').messages, tools: [{}] });
    assert.deepEqual(reply.toolCalls[0].args, { cards: [{ term: 'a' }] });
  });
  await withFetch([ok('stop', '', 8), calls('tool_calls', [tool('read', { id: 1 })])], async count => {
    const provider = new DeepSeekProvider({ apiKey: 'test' });
    const reply = await provider.completeWithTools({ messages: message('hi').messages, tools: [{}] });
    assert.equal(reply.toolCalls[0].name, 'read');
    assert.equal(count(), 2);
  });
});

test('streams the reply text and rebuilds tool calls from their fragments', async () => {
  const deltas = [];
  await withFetch([sse([
    { choices: [{ delta: { content: '正在' } }] },
    { choices: [{ delta: { content: '建立' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'crea' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'te', arguments: '{"cards"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':[]}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { completion_tokens_details: { reasoning_tokens: 4 } } },
    '[DONE]',
  ])], async (_count, bodies) => {
    const provider = new DeepSeekProvider({ apiKey: 'test' });
    const reply = await provider.completeWithTools({
      messages: message('hi').messages, tools: [{}], onDelta: event => deltas.push(event),
    });
    assert.equal(bodies[0].stream, true);
    assert.deepEqual(bodies[0].stream_options, { include_usage: true });
    assert.deepEqual(deltas, [{ delta: '正在' }, { delta: '建立' }]);
    assert.equal(reply.content, '正在建立');
    assert.deepEqual(reply.toolCalls, [{ id: 'call_1', name: 'create', args: { cards: [] } }]);
  });
});

test('tells the client to reset partial text before retrying a broken stream', async () => {
  await withFetch([
    sse([{ choices: [{ delta: { content: '部分' } }] }, 'not json']),
    sse([{ choices: [{ delta: { content: '完整' }, finish_reason: 'stop' }] }]),
  ], async count => {
    const deltas = [];
    const provider = new DeepSeekProvider({ apiKey: 'test' });
    const reply = await provider.completeWithTools({
      messages: message('hi').messages, tools: [{}], onDelta: event => deltas.push(event),
    });
    assert.equal(count(), 2);
    assert.deepEqual(deltas, [{ delta: '部分' }, { delta: '', reset: true }, { delta: '完整' }]);
    assert.equal(reply.content, '完整');
  });
});

// A stop is a decision, not a transport failure: the caller asked for it, so the wait settles under the
// caller's own signal and the failure is never retried — retrying is exactly what a stop says no to, and a
// completion writes nothing to the collection, which is why it is the one wait that may be abandoned.
test('a caller\'s abort settles the wait and is never retried', async () => {
  await withFetch([new Promise(() => {})], async calls => {
    const provider = new DeepSeekProvider({ apiKey: 'test', idleTimeoutMs: 30000 });
    const cancel = new AbortController();
    const pending = provider.completeWithTools({
      messages: message('hi').messages, tools: [{}], signal: cancel.signal, onDelta: () => {},
    });
    cancel.abort();
    const error = await pending.catch(failure => failure);
    assert.equal(error.cancelled, true);
    assert.equal(error.retryable, false);
    assert.match(error.message, /stopped/);
    assert.equal(calls(), 1);
  });
});

test('an abort that lands on a stream being read ends it the same way', async () => {
  await withFetch([() => stalledSse([{ choices: [{ delta: { content: '部分' } }] }])], async calls => {
    const provider = new DeepSeekProvider({ apiKey: 'test', idleTimeoutMs: 30000 });
    const cancel = new AbortController();
    const pending = provider.completeWithTools({
      messages: message('hi').messages, tools: [{}], signal: cancel.signal, onDelta: () => {},
    });
    setTimeout(() => cancel.abort(), 20);
    const error = await pending.catch(failure => failure);
    assert.equal(error.cancelled, true);
    assert.equal(calls(), 1);
  });
});

test('a request that never answers ends on its own deadline', async () => {
  // A transport that accepts the request and says nothing more: the abort cannot be the answer, because
  // the stub ignores the signal, so the deadline has to settle the wait by itself.
  await withFetch([new Promise(() => {})], async calls => {
    const provider = new DeepSeekProvider({ apiKey: 'test', idleTimeoutMs: 200 });
    await assert.rejects(
      provider.completeJson({ ...message('hi'), attempts: 1 }),
      /DeepSeek request failed: DeepSeek stopped answering for 200ms/,
    );
    assert.equal(calls(), 1);
  });
});

test('a stream that goes quiet expires, while a slow but live one does not', async () => {
  await withFetch([() => stalledSse([{ choices: [{ delta: { content: '部分' } }] }])], async () => {
    const provider = new DeepSeekProvider({ apiKey: 'test', idleTimeoutMs: 200 });
    await assert.rejects(
      provider.completeWithTools({ messages: message('hi').messages, tools: [{}], onDelta: () => {} }),
      /DeepSeek stream failed: DeepSeek stopped answering for 200ms/,
    );
  });
  await withFetch([dripSse([
    { choices: [{ delta: { content: '慢' } }] },
    { choices: [{ delta: { content: '但是' } }] },
    { choices: [{ delta: { content: '還活著' }, finish_reason: 'stop' }] },
  ], 120)], async count => {
    const provider = new DeepSeekProvider({ apiKey: 'test', idleTimeoutMs: 200 });
    const reply = await provider.completeWithTools({
      messages: message('hi').messages, tools: [{}], onDelta: () => {},
    });
    assert.equal(reply.content, '慢但是還活著');
    assert.equal(count(), 1);
  });
});
