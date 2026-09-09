const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { AnkiAgent } = require('../anki-agent');
const { compileProfile } = require('../card-profile');
const { englishProfile, profileLibrary } = require('./helpers/profile-fixture');
const { AgentChat } = require('../agent-chat');
const { createDatabase } = require('../../sqlite/database');
const Repository = require('../../sqlite/repository');

const card = { term: 'test', meaning: 'an examination', type: 'noun', typeLabel: 'C',
  translation: '測試', implications: ['考試', '測驗', '檢查'], phonetic: '/test/',
  examples: [{ en: 'Take a test.', zh: '參加測驗。' }] };
let callId = 0;
const action = (name, args) => ({ content: name, toolCalls: [{ id: `call_${++callId}`, name, args }] });
const fixture = (replies, options = {}) => {
  const calls = [];
  const records = [];
  const note = { noteId: 12, fields: { 詞彙: { value: 'test' }, 解釋: { value: 'old' } } };
  const client = {
    addNotes: async notes => { calls.push({ name: 'create', notes }); return [12]; },
    invoke: async (name, args) => {
      calls.push({ name, args });
      return name === 'currentDeckName' ? '_Todo' : [structuredClone(note)];
    },
  };
  const browser = {
    searchRows: async args => { calls.push({ name: 'search', args }); return { query: args.query, total: 1, hasMore: false, notes: [{ id: 12, term: 'test' }] }; },
    meta: async () => ({ decks: ['_Todo', 'English'], models: ['English'] }),
    updateNote: async (id, args) => { calls.push({ name: 'update', id, args }); note.fields.解釋.value = args.fields.解釋; },
    deleteNote: async id => calls.push({ name: 'delete', id }),
  };
  const prompts = [];
  const tools = [];
  const efforts = [];
  const classifications = [];
  const agent = new AnkiAgent({ browser, client, cardProfiles: profileLibrary({ English: englishProfile }),
    ...options,
    config: { modelName: 'English', allowDuplicate: true },
    provider: { completeWithTools: async ({ messages, tools: offered, reasoningEffort }) => { prompts.push(structuredClone(messages));
      tools.push(offered);
      efforts.push(reasoningEffort);
      return replies.shift() || { content: '完成', toolCalls: [] }; },
    // The `auto` classifier rides on the same provider; its own call is recorded separately so a test can
    // tell the routing decision apart from the turn it routed.
    completeJson: async ({ messages }) => { classifications.push(structuredClone(messages)); return { effort: 'high' }; } } });
  const run = (options = {}) => agent.respond({ messages: [{ role: 'user', content: 'request' }],
    record: operation => records.push(structuredClone(operation)), ...options });
  return { agent, run, calls, records, client, prompts, tools, efforts, classifications };
};

test('forwards the chat reasoning effort to the provider', async () => {
  const { run, efforts, classifications } = fixture([{ content: '討論', toolCalls: [] }]);
  await run({ reasoningEffort: 'low' });
  assert.deepEqual(efforts, ['low']);
  assert.deepEqual(classifications, []);
});

test('auto classifies the request and turns with the chosen effort', async () => {
  const { agent, run, efforts, classifications } = fixture([
    action('list_decks', {}), { content: '完成', toolCalls: [] }]);
  agent.provider.completeJson = async ({ messages }) => { classifications.push(messages); return { effort: 'low' }; };
  const events = [];
  await run({ reasoningEffort: 'auto', selectionNoteIds: [12], onEvent: event => events.push(event) });
  assert.equal(classifications.length, 1);
  assert.match(classifications[0][1].content, /Request: request/);
  assert.match(classifications[0][1].content, /1 note\(s\) selected/);
  assert.deepEqual(events[0], { type: 'effort', requested: 'auto', effort: 'low', source: 'auto' });
  assert.deepEqual(efforts, ['low', 'low']);
});

test('an absent effort means auto, and a failed classification uses the profile effort', async () => {
  const { agent, run, efforts } = fixture([{ content: '討論', toolCalls: [] }]);
  agent.provider.reasoningEffort = 'low';
  agent.provider.completeJson = async () => { throw new Error('DeepSeek API error: 404'); };
  const events = [];
  await run({ onEvent: event => events.push(event) });
  assert.deepEqual(events[0], { type: 'effort', requested: 'auto', effort: 'low', source: 'fallback',
    error: 'DeepSeek API error: 404' });
  assert.deepEqual(efforts, ['low']);
});

test('an auto profile falls back to the API default, never to auto', async () => {
  const { agent, run, efforts } = fixture([{ content: '討論', toolCalls: [] }]);
  agent.provider.reasoningEffort = 'auto';
  agent.provider.completeJson = async () => { throw new Error('no JSON mode'); };
  const events = [];
  await run({ onEvent: event => events.push(event) });
  assert.equal(events[0].effort, 'high');
  assert.deepEqual(efforts, ['high']);
});

// A stop ends the run at a step boundary. The turns below are the three places a boundary can be, and what
// each one proves is what the run has already committed: a step that started finishes, and only a step that
// has not started is dropped — so nothing is left half-applied for a later retry to guess at.
test('a stop before the turn starts runs nothing at all', async () => {
  const { run, prompts, calls } = fixture([{ content: '完成', toolCalls: [] }]);
  const cancel = new AbortController();
  cancel.abort();
  const result = await run({ signal: cancel.signal });
  assert.equal(result.cancelled, true);
  assert.match(result.content, /Stopped by you/);
  assert.deepEqual(result.operations, []);
  assert.deepEqual(prompts, []);
  assert.deepEqual(calls, []);
});

test('a stop while the model is thinking is read as a stop, not as a failure', async () => {
  const { agent, run, calls } = fixture([]);
  const cancel = new AbortController();
  // The provider aborts its own wait when the turn is stopped and reports that as a non-retryable stop, which
  // is what the agent has to read as the user's decision rather than as a transport failure.
  agent.provider.completeWithTools = async ({ signal }) => {
    assert.equal(signal, cancel.signal);
    cancel.abort();
    throw Object.assign(new Error('DeepSeek request stopped'), { cancelled: true, retryable: false });
  };
  const result = await run({ signal: cancel.signal });
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.operations, []);
  assert.deepEqual(calls, []);
});

test('a stop that lands while a write is being applied lets that write finish and stops after it', async () => {
  const { run, calls, records, client } = fixture([action('create_notes', { cards: [card] })]);
  const cancel = new AbortController();
  const addNotes = client.addNotes.bind(client);
  client.addNotes = async notes => { const ids = await addNotes(notes); cancel.abort(); return ids; };
  const result = await run({ signal: cancel.signal });
  assert.equal(result.cancelled, true);
  assert.match(result.content, /Stopped by you/);
  assert.equal(calls.filter(call => call.name === 'create').length, 1);
  assert.deepEqual(result.operations.map(operation => operation.status), ['completed']);
  assert.deepEqual(records.map(record => record.status), ['pending', 'completed']);
});

test('discussion performs no Anki writes', async () => {
  const { run, calls } = fixture([{ content: '先討論', toolCalls: [] }]);
  assert.equal((await run()).content, '先討論');
  assert.deepEqual(calls, []);
});

test('forwards the streamed reply text and the turn counter as events', async () => {
  const events = [];
  const agent = new AnkiAgent({
    browser: {}, client: {}, config: {},
    provider: { completeWithTools: async ({ onDelta }) => {
      onDelta({ delta: '正在' });
      onDelta({ delta: '', reset: true });
      onDelta({ delta: '完成' });
      return { content: '完成', toolCalls: [] };
    } },
  });
  const result = await agent.respond({
    messages: [{ role: 'user', content: 'hi' }], onEvent: event => events.push(event),
  });
  assert.equal(result.content, '完成');
  const [effortEvent, ...turns] = events;
  // No classifier on this provider, so `auto` degrades to the API default before the turn starts.
  assert.equal(effortEvent.type, 'effort');
  assert.equal(effortEvent.effort, 'high');
  assert.equal(effortEvent.source, 'fallback');
  assert.match(effortEvent.error, /completeJson is not a function/);
  assert.deepEqual(turns, [
    { type: 'phase', phase: 'thinking', step: 1 },
    { type: 'answer', delta: '正在', reset: false },
    { type: 'answer', delta: '', reset: true },
    { type: 'answer', delta: '完成', reset: false },
  ]);
});

test('runs a tool call that omits content and rejects one with no tool name', async () => {
  const { run, calls } = fixture([{ toolCalls: [{ id: 'call_1', name: 'search_notes', args: {} }] }, { content: '完成', toolCalls: [] }]);
  await run();
  assert.equal(calls[0].name, 'search');
  await assert.rejects(fixture([{ toolCalls: [] }]).run(), /content is required/);
  await assert.rejects(fixture([{ content: 'x', toolCalls: [{ id: 'c', args: {} }] }]).run(), /tool name is required/);
});

test('creates validated cards in the current deck unless a deck is specified, then reads them back', async () => {
  for (const deck of [undefined, 'Vocabulary']) {
    const { run, calls, records } = fixture([action('create_notes', { cards: [card], deck })]);
    await run();
    const created = calls.find(call => call.name === 'create');
    assert.equal(created.notes[0].deckName, deck || '_Todo');
    assert.equal(created.notes[0].fields.詞彙, 'test');
    assert.equal(calls.at(-1).name, 'notesInfo');
    assert.deepEqual(records.map(record => record.status), ['pending', 'completed']);
  }
});

test('returns invalid card content to the agent for repair before writing', async () => {
  const repaired = { ...card, term: 'repaired' };
  const { run, calls, prompts, records } = fixture([
    action('create_notes', { cards: [{ term: 'bad' }] }),
    action('create_notes', { cards: [repaired] }),
  ]);
  await run();
  assert.equal(calls.find(call => call.name === 'create').notes[0].fields.詞彙, 'repaired');
  assert.deepEqual(records.map(entry => entry.status), ['pending', 'failed', 'pending', 'completed']);
  const feedback = JSON.parse(prompts[1].at(-1).content);
  assert.equal(feedback.collectionWriteAttempted, false);
  assert.match(feedback.error, /phonetic is required/);
});

test('reports card validation details after the agent exhausts safe repairs', async () => {
  const invalid = () => action('create_notes', { cards: [{ term: 'bad' }] });
  const { run, calls, records } = fixture([invalid(), invalid(), invalid()]);
  await assert.rejects(run(), error => {
    assert.match(error.userMessage, /3 次嘗試/);
    assert.match(error.userMessage, /cards\[0\]\.phonetic is required/);
    assert.match(error.userMessage, /寫入 Anki 之前/);
    return true;
  });
  assert.deepEqual(calls, []);
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
});

test('reports when the agent stops instead of repairing invalid cards', async () => {
  const { run, calls } = fixture([
    action('create_notes', { cards: [{ term: 'bad' }] }),
    { content: '我無法補齊音標', toolCalls: [] },
  ]);
  await assert.rejects(run(), error => {
    assert.match(error.userMessage, /沒有修正/);
    assert.match(error.userMessage, /cards\[0\]\.phonetic is required/);
    assert.match(error.userMessage, /我無法補齊音標/);
    return true;
  });
  assert.deepEqual(calls, []);
});

test('a bare word or a comma-separated list becomes one multi-card create in order', async () => {
  const cards = [{ ...card, term: 'apple' }, { ...card, term: 'banana' }];
  const { run, calls, records } = fixture([action('create_notes', { cards })]);
  await run({ messages: [{ role: 'user', content: 'apple, banana' }] });
  const created = calls.find(call => call.name === 'create');
  assert.equal(created.notes.length, 2);
  assert.deepEqual(created.notes.map(note => note.fields.詞彙), ['apple', 'banana']);
  assert.deepEqual(new Set(created.notes.map(note => note.deckName)), new Set(['_Todo']));
  assert.equal(records.at(-1).status, 'completed');
});

// The tool the model is offered is the profile's own schema, so a note type the profile describes differently
// is written differently — there is no card shape in the agent itself.
test('offers create_notes with the configured profile\'s own card schema', async () => {
  const { run, tools, prompts } = fixture([{ content: '好', toolCalls: [] }]);
  await run();
  assert.deepEqual(tools[0].map(tool => tool.function.name),
    ['search_notes', 'read_note', 'create_notes', 'update_note', 'delete_note', 'list_decks', 'read_card_profile',
      'propose_card_profile', 'apply_card_profile']);
  const create = tools[0].find(tool => tool.function.name === 'create_notes');
  assert.deepEqual(create.function.parameters.properties.cards.items, englishProfile.cardJsonSchema);
  assert.match(prompts[0][0].content, /create_notes writes English notes through the card profile/);
});

test('validates and stores a card through the profile, not through a bundled one', async () => {
  const profile = compileProfile({ profile: 1, noteType: 'English',
    fields: [{ name: 'word', required: true }, { name: 'note' }],
    storage: [{ field: 'Front', of: 'word' }, { field: 'Back', of: 'note' }] });
  const { run, calls } = fixture([action('create_notes', { cards: [{ word: 'apple', note: '蘋果' }] }),
    { content: '好', toolCalls: [] }], { cardProfiles: profileLibrary({ English: profile }) });
  await run();
  const created = calls.find(call => call.name === 'create');
  assert.deepEqual(created.notes[0].fields, { Front: 'apple', Back: '蘋果' });
});

test('withholds create_notes and names the profile path when the note type has no profile', async () => {
  const { run, tools, prompts } = fixture([{ content: '好', toolCalls: [] }],
    { cardProfiles: profileLibrary({}) });
  await run();
  assert.deepEqual(tools[0].map(tool => tool.function.name),
    ['search_notes', 'read_note', 'update_note', 'delete_note', 'list_decks', 'read_card_profile',
      'propose_card_profile', 'apply_card_profile']);
  assert.match(prompts[0][0].content, /No card profile is configured for the English note type/);
  assert.match(prompts[0][0].content, /\/tmp\/card-profiles\/English\.json/);
});

test('answers a create_notes call made without a profile instead of writing', async () => {
  const { run, calls, records } = fixture([
    action('create_notes', { cards: [card] }),
    { content: '需要先建立 profile', toolCalls: [] },
  ], { cardProfiles: profileLibrary({}) });
  const reply = await run();
  assert.equal(calls.some(call => call.name === 'create'), false);
  const answered = records.find(entry => entry.status === 'completed');
  assert.match(answered.result.error, /No card profile is configured/);
  assert.match(answered.result.instruction, /\/tmp\/card-profiles\/English\.json/);
  assert.equal(reply.content, '需要先建立 profile');
});

test('the factory prompt carries the tool contract and none of the user\'s own conventions', async () => {
  const { run, prompts, tools } = fixture([{ content: '好', toolCalls: [] }]);
  await run();
  const system = prompts[0][0].content;
  assert.match(system, /through the provided tools/);
  assert.match(system, /create_notes validation error happens before any collection write/);
  // Bare words, lists, the default deck and the reply language are standing instructions now, so a fresh
  // install must not answer them from a hardcoded default.
  assert.doesNotMatch(system, /bare English word, phrase, or idiom/);
  assert.doesNotMatch(system, /Split lists longer than 50 items/);
  assert.doesNotMatch(system, /Default new notes to Anki's current deck/);
  assert.doesNotMatch(system, /Reply in Traditional Chinese/);
  // This app's own template field names and separators live in the card contract and the tool schema, so a
  // fresh install must not read them off the factory prompt as though they were the user's own note type.
  assert.doesNotMatch(system, /同義詞|反義詞|聯想詞|含意|範例/);
  assert.match(system, /never JSON/);
  assert.deepEqual(tools[0].map(tool => tool.function.name),
    ['search_notes', 'read_note', 'create_notes', 'update_note', 'delete_note', 'list_decks', 'read_card_profile',
      'propose_card_profile', 'apply_card_profile']);
});

// A selection narrows a read without ever taking the id away: the ledger is keyed on it, and a later write
// depends on it being there.
test('answers only the fields a read selected and always keeps the id', async () => {
  const { run, calls, records } = fixture([
    action('search_notes', { query: 'deck:English', select: 'term' }),
    action('read_note', { id: 12, select: ['fields'] }),
    action('list_decks', { select: 'currentDeck' }),
    { content: '好', toolCalls: [] },
  ]);
  await run();
  assert.deepEqual(calls.find(call => call.name === 'search').args.select, ['id', 'term']);
  const read = records.find(record => record.action.name === 'read_note' && record.status === 'completed');
  assert.deepEqual(Object.keys(read.result), ['noteId', 'fields']);
  const decks = records.find(record => record.action.name === 'list_decks' && record.status === 'completed');
  assert.deepEqual(decks.result, { currentDeck: '_Todo' });
});

// Which fields a row can carry is a fact about this app, so a selection the model invented is answered with
// the list to choose from instead of ending the turn.
test('answers an invented select instead of failing the turn', async () => {
  const { run, records } = fixture([action('search_notes', { select: 'nope' }), { content: '好', toolCalls: [] }]);
  await run();
  const refused = records.find(record => record.status === 'completed');
  assert.match(refused.result.error,
    /select must be one of: id, term, meaning, modelName, tags, createdAt, deckName, dueAt, flag/);
  assert.match(refused.result.instruction, /omit select/);
});

// The audit reads the note type it is judging instead of assuming this app's own field names, so the shape has
// to be answerable as data: the profile, with every default the compiler applied written out.
test('answers a card profile read with the note type\'s own fields and rules', async () => {
  const { run, records } = fixture([action('read_card_profile', {}), { content: '好', toolCalls: [] }]);
  await run();
  const answered = records.find(entry => entry.status === 'completed');
  assert.equal(answered.result.noteType, 'English');
  assert.deepEqual(answered.result.fields.map(field => field.name), englishProfile.fields);
  assert.deepEqual(answered.result.storage.filter(entry => entry.of.includes('meaning')),
    [{ field: '意思', of: ['meaning', 'translation'], join: '<br>' }]);
  assert.deepEqual(answered.result.fields.filter(field => field.required).map(field => field.name),
    ['meaning', 'translation', 'term', 'type']);
  assert.deepEqual(answered.result.fields.find(field => field.name === 'literal').requiredWhen,
    { field: 'type', in: 'phrase', message: 'for idioms and phrasal verbs' });
});

test('answers a card profile read for a note type that is not installed', async () => {
  const { run, records } = fixture([action('read_card_profile', { noteType: 'Japanese' }), { content: '好', toolCalls: [] }]);
  await run();
  const answered = records.find(entry => entry.status === 'completed');
  assert.match(answered.result.error, /No card profile is installed for the Japanese note type/);
  assert.deepEqual(answered.result.noteTypes, ['English']);
  assert.equal(answered.result.path, '/tmp/card-profiles/Japanese.json');
});

test('withholds the card profile tool when no profiles directory is configured', async () => {
  const { run, tools } = fixture([{ content: '好', toolCalls: [] }], { cardProfiles: null });
  await run();
  assert.deepEqual(tools[0].map(tool => tool.function.name),
    ['search_notes', 'read_note', 'update_note', 'delete_note', 'list_decks']);
});

test('searches lightweight rows with a bounded default limit and can list decks', async () => {
  const { run, calls } = fixture([action('search_notes', {}), action('list_decks', {}), { content: '好', toolCalls: [] }]);
  await run();
  assert.equal(calls[0].name, 'search');
  assert.equal(calls[0].args.query, '-nid:0');
  assert.equal(calls[0].args.limit, 50);
  const bounded = fixture([action('search_notes', { query: 'deck:English', limit: 5 }), { content: '好', toolCalls: [] }]);
  await bounded.run();
  assert.equal(bounded.calls[0].args.limit, 5);
  assert.equal(bounded.calls[0].args.query, 'deck:English');
  assert.ok(calls.some(call => call.name === 'currentDeckName'));
});

test('names the unknown field and the valid ones so the agent can repair the update', async () => {
  const { run } = fixture([action('read_note', { id: 12 }), action('update_note', { id: 12, fields: { 解釋: 'x', 意思: 'y' } })]);
  await assert.rejects(run(), /Unknown note field 意思; this note has: 詞彙, 解釋/);
  const empty = fixture([action('read_note', { id: 12 }), action('update_note', { id: 12, fields: {} })]);
  await assert.rejects(empty.run(), /fields must name at least one changed field/);
});

test('searches all decks and requires reading exact IDs before update/delete', async () => {
  const { run, calls, records } = fixture([
    action('search_notes', { query: '' }), action('read_note', { id: 12 }),
    action('update_note', { id: 12, fields: { 解釋: 'new' } }), action('delete_note', { id: 12 }),
  ]);
  await run();
  assert.equal(calls[0].args.query, '-nid:0');
  const updated = records.find(record => record.action.name === 'update_note' && record.status === 'completed');
  assert.equal(updated.result.before.fields.解釋.value, 'old');
  assert.equal(updated.result.after.fields.解釋.value, 'new');
  assert.equal(calls.at(-1).name, 'delete');
  const unread = fixture([action('delete_note', { id: 99 })]);
  await assert.rejects(unread.run(), /Read the target/);
  assert.deepEqual(unread.calls, []);
});

test('transport failure records an unknown write outcome without retrying', async () => {
  const { run, client, records } = fixture([action('create_notes', { cards: [card] })]);
  let attempts = 0;
  client.addNotes = async () => { attempts++; throw new Error('transport failed'); };
  await assert.rejects(run(), /transport failed/);
  assert.equal(attempts, 1);
  assert.equal(records.at(-1).status, 'failed');
  assert.equal(records.at(-1).outcomeUnknown, true);
});

test('browser selection is forwarded as read-before-write context', async () => {
  const { run, prompts } = fixture([{ content: '好', toolCalls: [] }]);
  await run({ selectionNoteIds: [12, 34] });
  assert.equal(prompts[0][1].role, 'user');
  assert.match(prompts[0][1].content, /12, 34/);
  const empty = fixture([{ content: '好', toolCalls: [] }]);
  await empty.run();
  assert.equal(empty.prompts[0][1].content, 'request');
});

test('retry marks the request as user-authorized to resume', async () => {
  const { run, prompts } = fixture([{ content: '好', toolCalls: [] }]);
  await run({ retry: true });
  assert.equal(prompts[0][1].role, 'user');
  assert.match(prompts[0][1].content, /Retry \(user-authorized\)/);
  const combined = fixture([{ content: '好', toolCalls: [] }]);
  await combined.run({ selectionNoteIds: [12], retry: true });
  assert.match(combined.prompts[0][1].content, /Browser selection/);
  assert.match(combined.prompts[0][2].content, /Retry \(user-authorized\)/);
});

test('replays a completed tool call as a native assistant/tool pair', async () => {
  const { run, prompts } = fixture([action('search_notes', { query: '' }), { content: '完成', toolCalls: [] }]);
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
const record = (name, args, result) => ({ role: 'tool', content: JSON.stringify({ action: { name, args }, status: 'completed', result }) });

test('a note seen in an earlier turn stays writable without a fresh read', async () => {
  const history = [
    { role: 'user', content: 'request' },
    record('read', { id: 12 }, { noteId: 12, fields: { 詞彙: { value: 'test' }, 解釋: { value: 'old' } } }),
  ];
  const updated = fixture([action('update_note', { id: 12, fields: { 解釋: 'new' } })]);
  await updated.run({ messages: history });
  assert.equal(updated.calls[0].name, 'update');
  const deleted = fixture([action('delete_note', { id: 12 })]);
  await deleted.run({ messages: history });
  assert.equal(deleted.calls[0].name, 'delete');
});

test('a history written with the current names grants the same credit', async t => {
  const history = [record('read_note', { id: 12 }, { noteId: 12, fields: { 詞彙: { value: 'test' }, 解釋: { value: 'old' } } })];
  const updated = fixture([action('update_note', { id: 12, fields: { 解釋: 'new' } })]);
  await updated.run({ messages: history });
  assert.equal(updated.calls[0].name, 'update');
});test('an update survives across turns, and a deleted note is forgotten', async () => {
  const history = [record('update', { id: 12 }, { id: 12, before: null, after: { noteId: 12, fields: { 解釋: { value: 'new' } } } })];
  const again = fixture([action('update_note', { id: 12, fields: { 解釋: 'newer' } })]);
  await again.run({ messages: history });
  assert.equal(again.calls[0].name, 'update');
  const gone = fixture([action('update_note', { id: 12, fields: { 解釋: 'x' } })]);
  await assert.rejects(gone.run({ messages: [...history, record('delete', { id: 12 }, { id: 12, deleted: true })] }), /Read the target/);
  assert.deepEqual(gone.calls, []);
});

test('a created note can be updated in the same turn and in a later one', async () => {
  const created = { notes: [{ noteId: 12, fields: { 詞彙: { value: 'test' }, 解釋: { value: 'old' } } }] };
  const sameTurn = fixture([action('create_notes', { cards: [card] }), action('update_note', { id: 12, fields: { 解釋: 'new' } })]);
  await sameTurn.run();
  assert.deepEqual(sameTurn.calls.map(call => call.name),
    ['currentDeckName', 'create', 'notesInfo', 'update', 'notesInfo']);
  const nextTurn = fixture([action('update_note', { id: 12, fields: { 解釋: 'new' } })]);
  await nextTurn.run({ messages: [record('create', { cards: [card] }, created)] });
  assert.equal(nextTurn.calls[0].name, 'update');
});

test('malformed or unrelated tool records never grant write access', async () => {
  const history = [
    { role: 'tool', content: 'not json' },
    { role: 'tool', content: JSON.stringify({ action: { name: 'read', args: { id: 12 } }, status: 'failed', error: 'boom' }) },
    { role: 'tool', content: JSON.stringify({ action: { name: 'search', args: {} }, status: 'completed', result: { notes: [{ id: 12 }] } }) },
    { role: 'assistant', content: JSON.stringify({ content: 'x', action: { name: 'read', args: { id: 12 } } }) },
  ];
  const { run, calls } = fixture([action('delete_note', { id: 12 })]);
  await assert.rejects(run({ messages: history }), /Read the target/);
  assert.deepEqual(calls, []);
});

const chatFixture = t => {
  const db = createDatabase({ dbPath: ':memory:', migrationsDir: path.resolve(__dirname, '../../sqlite/migrations') });
  t.after(() => db.close());
  const repository = new Repository(db);
  const session = repository.createSession();
  let attempts = 0;
  const received = [];
  const agent = { respond: async args => { attempts++; received.push(args); return { content: '完成', operations: [] }; } };
  return { db, repository, session, agent, received, attempts: () => attempts,
    chat: new AgentChat({ db, repository, agent }) };
};

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

test('chat forwards the browser selection to the agent', async t => {
  const f = chatFixture(t);
  await f.chat.send(f.session.id, { content: '改寫這兩張', requestId: 'one', selectionNoteIds: [12, 34] });
  assert.deepEqual(f.received[0].selectionNoteIds, [12, 34]);
  await f.chat.send(f.session.id, { content: '改寫這兩張', requestId: 'two' });
  assert.deepEqual(f.received[1].selectionNoteIds, []);
});

test('chat reports every tool transition to a live listener as it is persisted', async t => {
  const f = chatFixture(t);
  f.agent.respond = async ({ record }) => {
    record({ action: { name: 'search_notes', args: {} }, status: 'pending' });
    record({ action: { name: 'search_notes', args: {} }, status: 'completed', result: { total: 0 } });
    return { content: '完成', operations: [] };
  };
  const events = [];
  const payload = await f.chat.send(f.session.id, { content: 'search', requestId: 'one',
    onEvent: event => events.push(event) });
  assert.deepEqual(events.map(event => event.type), ['tool', 'tool']);
  assert.deepEqual(events.map(event => event.operation.status), ['pending', 'completed']);
  assert.deepEqual(events.map(event => event.message.id),
    f.repository.listMessages(f.session.id).filter(message => message.role === 'tool').map(message => message.id));
  assert.equal(payload.assistantMessage.content, '完成');
});

test('chat without a listener still runs unchanged', async t => {
  const f = chatFixture(t);
  const payload = await f.chat.send(f.session.id, { content: 'create', requestId: 'one' });
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.operations, []);
});

test('the agent announces a thinking phase before every model call', async () => {
  const { run } = fixture([action('list_decks', {}), { content: '好', toolCalls: [] }]);
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
      userMessage: '無法建立卡片：第 6 張卡片缺少音標。失敗發生在寫入 Anki 之前，沒有新增卡片。',
    });
  };
  const result = await f.chat.send(f.session.id, { content: 'create', requestId: 'safe-failure' });
  assert.equal(result.failed, true);
  assert.match(result.assistantMessage.content, /第 6 張卡片缺少音標/);
  assert.doesNotMatch(result.assistantMessage.content, /檢查 Anki/);
});

test('a failed request exposes retry data, and retry resumes the original request', async t => {
  const f = chatFixture(t);
  const calls = [];
  f.agent.respond = async args => { calls.push(args); throw new Error('offline'); };
  const failed = await f.chat.send(f.session.id, { content: 'create', requestId: 'one', selectionNoteIds: [12] });
  assert.equal(failed.failed, true);
  const [user, assistant] = f.repository.listMessages(f.session.id);
  assert.deepEqual(JSON.parse(user.payload_json), { requestId: 'one', selectionNoteIds: [12], retry: false });
  assert.deepEqual(JSON.parse(assistant.payload_json), { failed: true, retry: { content: 'create', selectionNoteIds: [12] } });

  f.agent.respond = async args => { calls.push(args); return { content: '完成', operations: [] }; };
  const retried = await f.chat.send(f.session.id,
    { content: 'create', requestId: 'two', selectionNoteIds: [12], retry: true });
  assert.equal(retried.failed, false);
  assert.equal(calls.at(-1).retry, true);
  assert.equal(f.repository.listMessages(f.session.id).at(-2).payload_json.includes('"retry":true'), true);
});
