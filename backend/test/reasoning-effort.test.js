const test = require('node:test');
const assert = require('node:assert/strict');

const { chooseReasoningEffort, readEffort } = require('../reasoning-effort');

const providerAnswering = reply => {
  const calls = [];
  return {
    calls,
    provider: {
      completeJson: async options => {
        calls.push(options);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
};

test('reads the level out of an object or a bare string', () => {
  assert.equal(readEffort({ effort: 'low' }), 'low');
  assert.equal(readEffort({ effort: ' HIGH ' }), 'high');
  assert.equal(readEffort('none'), 'none');
});

test('rejects a level the API does not offer', () => {
  assert.throws(() => readEffort({ effort: 'medium' }), /Unknown reasoning effort/);
  assert.throws(() => readEffort({}), /Unknown reasoning effort/);
  assert.throws(() => readEffort({ effort: 'auto' }), /Unknown reasoning effort/);
  assert.throws(() => readEffort({ effort: 'max' }), /Unknown reasoning effort/);
});

test('asks with thinking off, one attempt, and a JSON-mode reply', async () => {
  const { calls, provider } = providerAnswering({ effort: 'low' });
  const decision = await chooseReasoningEffort({ provider, request: 'thickness', fallback: 'high' });
  assert.deepEqual(decision, { effort: 'low', source: 'auto' });
  assert.equal(calls[0].reasoningEffort, 'none');
  assert.equal(calls[0].attempts, 1);
  assert.deepEqual(calls[0].messages[0].role, 'system');
});

test('gives the classifier the request, the selection, and the recent turns', async () => {
  const { calls, provider } = providerAnswering({ effort: 'high' });
  await chooseReasoningEffort({ provider, request: '改寫這兩張', selection: 2,
    history: ['user: 找出 beach', 'assistant: 找到 2 張'], fallback: 'high' });
  const described = calls[0].messages[1].content;
  assert.match(described, /Request: 改寫這兩張/);
  assert.match(described, /2 note\(s\) selected/);
  assert.match(described, /user: 找出 beach/);
});

test('falls back to the profile effort when the classifier fails', async () => {
  const { provider } = providerAnswering(new Error('DeepSeek API error: 404'));
  assert.deepEqual(await chooseReasoningEffort({ provider, request: 'hi', fallback: 'low' }),
    { effort: 'low', source: 'fallback', error: 'DeepSeek API error: 404' });
});

test('falls back when the classifier answers something unusable', async () => {
  const { provider } = providerAnswering({ effort: 'I think this is medium' });
  const decision = await chooseReasoningEffort({ provider, request: 'hi', fallback: 'high' });
  assert.equal(decision.effort, 'high');
  assert.equal(decision.source, 'fallback');
  assert.match(decision.error, /Unknown reasoning effort/);
});
