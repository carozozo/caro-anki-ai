const test = require('node:test');
const assert = require('node:assert/strict');
const { action, card, fixture } = require('./helpers/anki-agent-fixture');

test('retry marks the request as user-authorized to resume', async () => {
  const { run, prompts } = fixture([{ content: 'ok', toolCalls: [] }]);
  await run({ retry: true });
  assert.equal(prompts[0][1].role, 'user');
  assert.match(prompts[0][1].content, /Retry \(user-authorized\)/);
  const combined = fixture([{ content: 'ok', toolCalls: [] }]);
  await combined.run({ selectionNoteIds: [12], retry: true });
  assert.match(combined.prompts[0][1].content, /Browser selection/);
  assert.match(combined.prompts[0][2].content, /Retry \(user-authorized\)/);
});

test('replays a completed tool call as a native assistant/tool pair', async () => {
  const { run, prompts } = fixture([action('search_notes', { query: '' }), { content: 'done', toolCalls: [] }]);
  await run();
  const assistant = prompts[1].at(-2);
  const toolMessage = prompts[1].at(-1);
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.tool_calls[0].function.name, 'search_notes');
  assert.equal(assistant.tool_calls[0].type, 'function');
  assert.equal(toolMessage.role, 'tool');
  assert.equal(toolMessage.tool_call_id, assistant.tool_calls[0].id);
});

// A conversation persisted before the tool names were namespaced still has to grant read-before-write credit,
// so the histories below deliberately keep the old names; `LEGACY_TOOL_NAMES` is what resolves them.
const record = (name, args, result) => ({
  role: 'tool', content: JSON.stringify({ action: { name, args }, status: 'completed', result }),
});

test('a note seen in an earlier turn stays writable without a fresh read', async () => {
  const history = [
    { role: 'user', content: 'request' },
    record('read', { id: 12 }, { noteId: 12, fields: { Term: { value: 'test' }, Meaning: { value: 'old' } } }),
  ];
  const updated = fixture([action('update_notes', { notes: [{ id: 12, fields: { Meaning: 'new' } }] })]);
  await updated.run({ messages: history });
  assert.equal(updated.calls[0].name, 'update');
  const deleted = fixture([action('delete_notes', { ids: [12] })]);
  await deleted.run({ messages: history });
  assert.equal(deleted.calls[0].name, 'delete');
});

test('a history written with the batch names grants the same credit', async () => {
  const history = [record('read_notes', { ids: [12] },
    { notes: [{ noteId: 12, fields: { Term: { value: 'test' }, Meaning: { value: 'old' } } }] })];
  const updated = fixture([action('update_notes', { notes: [{ id: 12, fields: { Meaning: 'new' } }] })]);
  await updated.run({ messages: history });
  assert.equal(updated.calls[0].name, 'update');
  const updatedHistory = [record('update_notes', { notes: [{ id: 12 }] },
    { notes: [{ id: 12, before: null, after: { noteId: 12, fields: { Meaning: { value: 'new' } } } }] })];
  const again = fixture([action('update_notes', { notes: [{ id: 12, fields: { Meaning: 'newer' } }] })]);
  await again.run({ messages: updatedHistory });
  assert.equal(again.calls[0].name, 'update');
});

// The singular spellings the batch tools replaced are history now: a conversation recorded under
// `read_note`/`update_note`/`delete_note` must keep granting credit and forgetting deleted notes.
test('a history written with the singular names that preceded the batch grants the same credit', async () => {
  const read = [record('read_note', { id: 12 },
    { noteId: 12, fields: { Term: { value: 'test' }, Meaning: { value: 'old' } } })];
  const updated = fixture([action('update_notes', { notes: [{ id: 12, fields: { Meaning: 'new' } }] })]);
  await updated.run({ messages: read });
  assert.equal(updated.calls[0].name, 'update');
  const updatedHistory = [record('update_note', { id: 12, fields: { Meaning: 'new' } },
    { id: 12, before: null, after: { noteId: 12, fields: { Meaning: { value: 'new' } } } })];
  const again = fixture([action('update_notes', { notes: [{ id: 12, fields: { Meaning: 'newer' } }] })]);
  await again.run({ messages: updatedHistory });
  assert.equal(again.calls[0].name, 'update');
  const gone = fixture([action('update_notes', { notes: [{ id: 12, fields: { Meaning: 'x' } }] })]);
  await assert.rejects(gone.run({
    messages: [...read, record('delete_note', { id: 12 }, { id: 12, before: null, deleted: true })],
  }), /Read the target/);
  assert.deepEqual(gone.calls, []);
});

test('an update survives across turns, and a deleted note is forgotten', async () => {
  const history = [record('update', { id: 12 }, {
    id: 12, before: null, after: { noteId: 12, fields: { Meaning: { value: 'new' } } },
  })];
  const again = fixture([action('update_notes', { notes: [{ id: 12, fields: { Meaning: 'newer' } }] })]);
  await again.run({ messages: history });
  assert.equal(again.calls[0].name, 'update');
  const gone = fixture([
    action('update_notes', { notes: [{ id: 12, fields: { Meaning: 'x' } }] }),
  ]);
  await assert.rejects(gone.run({
    messages: [...history, record('delete', { id: 12 }, { id: 12, deleted: true })],
  }), /Read the target/);
  assert.deepEqual(gone.calls, []);
});

test('a created note can be updated in the same turn and in a later one', async () => {
  const created = { notes: [{ noteId: 12, fields: { Term: { value: 'test' }, Meaning: { value: 'old' } } }] };
  const sameTurn = fixture([
    action('create_notes', { cards: [card] }),
    action('update_notes', { notes: [{ id: 12, fields: { Meaning: 'new' } }] }),
  ]);
  await sameTurn.run();
  assert.deepEqual(sameTurn.calls.map(call => call.name),
    ['currentDeckName', 'create', 'notesInfo', 'update', 'notesInfo']);
  const nextTurn = fixture([action('update_notes', { notes: [{ id: 12, fields: { Meaning: 'new' } }] })]);
  await nextTurn.run({ messages: [record('create', { cards: [card] }, created)] });
  assert.equal(nextTurn.calls[0].name, 'update');
});

test('malformed or unrelated tool records never grant write access', async () => {
  const history = [
    { role: 'tool', content: 'not json' },
    {
      role: 'tool',
      content: JSON.stringify({ action: { name: 'read', args: { id: 12 } }, status: 'failed', error: 'boom' }),
    },
    {
      role: 'tool',
      content: JSON.stringify({
        action: { name: 'search', args: {} }, status: 'completed', result: { notes: [{ id: 12 }] },
      }),
    },
    { role: 'assistant', content: JSON.stringify({ content: 'x', action: { name: 'read', args: { id: 12 } } }) },
  ];
  const { run, calls } = fixture([action('delete_notes', { ids: [12] })]);
  await assert.rejects(run({ messages: history }), /Read the target/);
  assert.deepEqual(calls, []);
});
