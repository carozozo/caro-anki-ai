const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentChat } = require('../agent-chat');
const { action, chatFixture, fixture } = require('./helpers/anki-agent-fixture');

// Cancelling is a request the run reads at its own boundary, so the token is handed to the agent and the slot
// is released like any other turn's — and a stop for a request that already ended is not an error to report.
test('a stop reaches the running turn, and only the one it names', async t => {
  const f = chatFixture(t);
  let signal = null;
  let release = () => {};
  f.agent.respond = async args => {
    signal = args.signal;
    await new Promise(resolve => { release = resolve; });
    return { content: 'Stopped by you.', operations: [], skills: [], cancelled: signal.aborted };
  };
  const running = f.chat.send(f.session.id, { content: 'create', requestId: 'one' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.chat.cancel('two'), false);
  assert.equal(f.chat.cancel('one'), true);
  release();
  const payload = await running;
  assert.equal(payload.cancelled, true);
  assert.equal(payload.failed, false);
  assert.equal(f.chat.busy, false);
  // The stop is recorded on the reply's own payload: every step of a stopped run ran to its end, so the steps
  // cannot say the run was stopped and the window has nothing else to read it from.
  assert.equal(f.repository.listMessages(f.session.id).at(-1).payload_json, JSON.stringify({ cancelled: true }));
  assert.equal(f.chat.cancel('one'), false);
});

test('the first request receives an AI summary title without changing later titles', async t => {
  const f = chatFixture(t);
  let titleInput;
  f.agent.summarizeTitle = async input => { titleInput = input; return 'Create travel cards'; };
  await f.chat.send(f.session.id, { content: 'c', requestId: 'one' });
  assert.equal(titleInput.content, 'c');
  assert.equal(titleInput.answer, 'done');
  assert.equal(titleInput.signal.aborted, false);
  assert.equal(f.repository.getSession(f.session.id).title, 'Create travel cards');
  f.agent.summarizeTitle = async () => 'Should not replace the title';
  await f.chat.send(f.session.id, { content: 'Add examples', requestId: 'two' });
  assert.equal(f.repository.getSession(f.session.id).title, 'Create travel cards');
});

test('a failed title summary does not interrupt the first request', async t => {
  const f = chatFixture(t);
  f.agent.summarizeTitle = async () => { throw new Error('title service unavailable'); };
  const result = await f.chat.send(f.session.id, { content: 'Create travel cards', requestId: 'one' });
  assert.equal(result.failed, false);
  assert.equal(f.repository.getSession(f.session.id).title, 'Untitled card workspace');
});

test('chat forwards the browser selection to the agent', async t => {
  const f = chatFixture(t);
  await f.chat.send(f.session.id, { content: 'rewrite these two', requestId: 'one', selectionNoteIds: [12, 34] });
  assert.deepEqual(f.received[0].selectionNoteIds, [12, 34]);
  await f.chat.send(f.session.id, { content: 'rewrite these two', requestId: 'two' });
  assert.deepEqual(f.received[1].selectionNoteIds, []);
});

test('chat reports every tool transition to a live listener as it is persisted', async t => {
  const f = chatFixture(t);
  f.agent.respond = async ({ record }) => {
    record({ action: { name: 'search_notes', args: {} }, status: 'pending' });
    record({ action: { name: 'search_notes', args: {} }, status: 'completed', result: { total: 0 } });
    return { content: 'done', operations: [] };
  };
  const events = [];
  const payload = await f.chat.send(f.session.id, { content: 'search', requestId: 'one',
    onEvent: event => events.push(event) });
  assert.deepEqual(events.map(event => event.type), ['tool', 'tool']);
  assert.deepEqual(events.map(event => event.operation.status), ['pending', 'completed']);
  assert.deepEqual(events.map(event => event.message.id),
    f.repository.listMessages(f.session.id).filter(message => message.role === 'tool').map(message => message.id));
  assert.equal(payload.assistantMessage.content, 'done');
});

test('chat persists when a reply reaches its configured request step limit', async t => {
  const f = chatFixture(t);
  f.agent.respond = async () => ({ content: 'Need your decision.', operations: [], skills: [],
    stepLimitReached: true, stepLimit: 18 });
  const result = await f.chat.send(f.session.id, { content: 'create', requestId: 'one' });

  assert.equal(result.stepLimitReached, true);
  assert.deepEqual(JSON.parse(f.repository.listMessages(f.session.id).at(-1).payload_json),
    { stepLimitReached: true, stepLimit: 18 });
});

test('chat without a listener still runs unchanged', async t => {
  const f = chatFixture(t);
  const payload = await f.chat.send(f.session.id, { content: 'create', requestId: 'one' });
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.operations, []);
});

test('the agent announces a thinking phase before every model call', async () => {
  const { run } = fixture([action('list_decks', {}), { content: 'ok', toolCalls: [] }]);
  const events = [];
  await run({ reasoningEffort: 'high', onEvent: event => events.push(event) });
  assert.deepEqual(events, [
    { type: 'phase', phase: 'thinking', step: 1 },
    { type: 'phase', phase: 'thinking', step: 2 },
  ]);
});

test('chat forwards the reasoning effort and records it on the user message', async t => {
  const f = chatFixture(t);
  await f.chat.send(f.session.id, { content: 'create', requestId: 'one', reasoningEffort: 'low' });
  assert.equal(f.received[0].reasoningEffort, 'low');
  assert.equal(JSON.parse(f.repository.listMessages(f.session.id)[0].payload_json).reasoningEffort, 'low');
  await f.chat.send(f.session.id, { content: 'create', requestId: 'two' });
  assert.equal(f.received[1].reasoningEffort, undefined);
});

test('completed requests survive service recreation and cannot execute twice', async t => {
  const f = chatFixture(t);
  const body = { content: 'create', requestId: 'one' };
  const first = await f.chat.send(f.session.id, body);
  const recreated = new AgentChat(f);
  assert.deepEqual(await recreated.send(f.session.id, body), JSON.parse(JSON.stringify(first)));
  assert.equal(f.attempts(), 1);
  const refusal = await f.chat.send(f.session.id, { ...body, content: 'delete' }).catch(error => error);
  assert.match(refusal.message, /already used/);
  assert.equal(refusal.code, 'request_reused');
  assert.equal(f.repository.listMessages(f.session.id).length, 2);
});

test('interrupted requests are never automatically replayed', async t => {
  const f = chatFixture(t);
  f.db.prepare('INSERT INTO agent_runs (id, session_id, content) VALUES (?, ?, ?)').run('one', f.session.id, 'create');
  const refusal = await f.chat.send(f.session.id, { content: 'create', requestId: 'one' }).catch(error => error);
  assert.match(refusal.message, /interrupted/);
  assert.equal(refusal.code, 'run_pending');
  assert.equal(refusal.statusCode, 409);
  assert.equal(f.attempts(), 0);
});

test('a refusal names whether the turn started, so a resend is told apart from an inspection', async t => {
  const f = chatFixture(t);
  const running = f.chat.send(f.session.id, { content: 'create', requestId: 'one' });
  // The reservation is taken before the method's first await, so a second turn in the same tick is refused
  // rather than started beside the first — and the refusal says nothing ran, which is what lets a caller
  // resend it as it stands instead of leaving the user with a record no backend ever took.
  const refusal = await f.chat.send(f.session.id, { content: 'delete', requestId: 'two' }).catch(error => error);
  assert.equal(refusal.code, 'not_started');
  assert.equal(refusal.statusCode, 409);
  assert.match(refusal.message, /Another AI operation is running/);
  await running;
  assert.equal(f.attempts(), 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM agent_runs WHERE id = ?').get('two').count, 0);
});

test('a turn that fails before it starts releases the slot and leaves its request unused', async t => {
  const f = chatFixture(t);
  let unavailable = true;
  const chat = new AgentChat({
    db: f.db, repository: f.repository, agent: f.agent,
    getAgent: async () => { if (unavailable) throw new Error('no profile'); return f.agent; },
  });
  const refusal = await chat.send(f.session.id, { content: 'create', requestId: 'one' }).catch(error => error);
  assert.match(refusal.message, /no profile/);
  assert.equal(chat.busy, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM agent_runs').get().count, 0);
  unavailable = false;
  assert.equal((await chat.send(f.session.id, { content: 'create', requestId: 'one' })).ok, true);
  assert.equal(f.attempts(), 1);
});

test('provider failure is saved, and clearing sessions removes dependent runs', async t => {
  const f = chatFixture(t);
  f.agent.respond = async () => { throw new Error('offline'); };
  const result = await f.chat.send(f.session.id, { content: 'create', requestId: 'one' });
  assert.equal(result.failed, true);
  assert.equal(f.chat.busy, false);
  assert.match(f.repository.listMessages(f.session.id).at(-1).content, /offline/);
  f.repository.clearSessions();
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM agent_runs').get().count, 0);
});

test('chat displays a specific safe failure instead of telling the user to inspect Anki', async t => {
  const f = chatFixture(t);
  f.agent.respond = async () => {
    throw Object.assign(new Error('cards[5].phonetic is required'), {
      userMessage: 'Could not create cards: card 6 is missing a phonetic. The failure happened before the '
        + 'write to Anki, so this failed create added no cards.',
    });
  };
  const result = await f.chat.send(f.session.id, { content: 'create', requestId: 'safe-failure' });
  assert.equal(result.failed, true);
  assert.match(result.assistantMessage.content, /card 6 is missing a phonetic/);
  assert.doesNotMatch(result.assistantMessage.content, /check Anki/);
});

test('a failed request exposes retry data, and retry resumes the original request', async t => {
  const f = chatFixture(t);
  const calls = [];
  f.agent.respond = async args => { calls.push(args); throw new Error('offline'); };
  const failed = await f.chat.send(f.session.id, { content: 'create', requestId: 'one', selectionNoteIds: [12] });
  assert.equal(failed.failed, true);
  const [user, assistant] = f.repository.listMessages(f.session.id);
  assert.deepEqual(JSON.parse(user.payload_json), { requestId: 'one', selectionNoteIds: [12], retry: false });
  assert.deepEqual(JSON.parse(assistant.payload_json), {
    failed: true, retry: { content: 'create', selectionNoteIds: [12] },
  });

  f.agent.respond = async args => { calls.push(args); return { content: 'done', operations: [] }; };
  const retried = await f.chat.send(f.session.id,
    { content: 'create', requestId: 'two', selectionNoteIds: [12], retry: true });
  assert.equal(retried.failed, false);
  assert.equal(calls.at(-1).retry, true);
  assert.equal(f.repository.listMessages(f.session.id).at(-2).payload_json.includes('"retry":true'), true);
});
