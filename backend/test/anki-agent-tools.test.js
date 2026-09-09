const test = require('node:test');
const assert = require('node:assert/strict');
const { AnkiAgent } = require('../anki-agent');
const { compileProfile } = require('../card-profile');
const { englishProfile, profileLibrary } = require('./helpers/profile-fixture');
const { action, batchFixture, card, fixture } = require('./helpers/anki-agent-fixture');

test('forwards the chat reasoning effort to the provider', async () => {
  const { run, efforts, classifications } = fixture([{ content: 'thinking', toolCalls: [] }]);
  await run({ reasoningEffort: 'low' });
  assert.deepEqual(efforts, ['low']);
  assert.deepEqual(classifications, []);
});

test('auto classifies the request and turns with the chosen effort', async () => {
  const { agent, run, efforts, classifications } = fixture([
    action('list_decks', {}), { content: 'done', toolCalls: [] }]);
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
  const { agent, run, efforts } = fixture([{ content: 'thinking', toolCalls: [] }]);
  agent.provider.reasoningEffort = 'low';
  agent.provider.completeJson = async () => { throw new Error('DeepSeek API error: 404'); };
  const events = [];
  await run({ onEvent: event => events.push(event) });
  assert.deepEqual(events[0], { type: 'effort', requested: 'auto', effort: 'low', source: 'fallback',
    error: 'DeepSeek API error: 404' });
  assert.deepEqual(efforts, ['low']);
});

test('an auto profile falls back to the API default, never to auto', async () => {
  const { agent, run, efforts } = fixture([{ content: 'thinking', toolCalls: [] }]);
  agent.provider.reasoningEffort = 'auto';
  agent.provider.completeJson = async () => { throw new Error('no JSON mode'); };
  const events = [];
  await run({ onEvent: event => events.push(event) });
  assert.equal(events[0].effort, 'high');
  assert.deepEqual(efforts, ['high']);
});

test('summarizes a new conversation title with a single non-thinking JSON call', async () => {
  const { agent } = fixture([]);
  let request;
  agent.provider.completeJson = async options => {
    request = options;
    return { title: '  建立\n旅行單字卡  ' };
  };
  assert.equal(
    await agent.summarizeTitle({ content: 'c', answer: '正在建立旅行英文單字卡。' }),
    '建立 旅行單字卡',
  );
  assert.equal(request.reasoningEffort, 'none');
  assert.equal(request.attempts, 1);
  assert.match(request.messages[0].content, /specific task title/);
  assert.match(request.messages[0].content, /resolve aliases/);
  assert.equal(request.messages[1].content, 'Request:\nc\n\nFirst answer:\n正在建立旅行英文單字卡。');
});

test('puts the profile default language into chat and title prompts', async () => {
  const { agent, run, prompts } = fixture([{ content: 'こんにちは。', toolCalls: [] }], { language: 'ja' });
  await run();
  assert.match(prompts[0][0].content, /selected default language is Japanese \(ja\)/);
  assert.match(prompts[0][0].content, /chat replies and for prose you author in instructions, skills, and memories/);

  let titleRequest;
  agent.provider.completeJson = async request => {
    titleRequest = request;
    return { title: '単語カード' };
  };
  await agent.summarizeTitle({ content: '単語カードを作る', answer: '準備します。' });
  assert.match(titleRequest.messages[0].content, /selected default language is Japanese \(ja\)/);
});

// A stop ends the run at a step boundary. The turns below are the three places a boundary can be, and what
// each one proves is what the run has already committed: a step that started finishes, and only a step that
// has not started is dropped — so nothing is left half-applied for a later retry to guess at.
test('a stop before the turn starts runs nothing at all', async () => {
  const { run, prompts, calls } = fixture([{ content: 'done', toolCalls: [] }]);
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
  const { run, calls } = fixture([{ content: 'thinking first', toolCalls: [] }]);
  assert.equal((await run()).content, "thinking first");
  assert.deepEqual(calls, []);
});

test('forwards the streamed reply text and the turn counter as events', async () => {
  const events = [];
  const agent = new AnkiAgent({
    browser: {}, client: {}, config: {},
    provider: { completeWithTools: async ({ onDelta }) => {
      onDelta({ delta: 'working' });
      onDelta({ delta: '', reset: true });
      onDelta({ delta: 'done' });
      return { content: 'done', toolCalls: [] };
    } },
  });
  const result = await agent.respond({
    messages: [{ role: 'user', content: 'hi' }], onEvent: event => events.push(event),
  });
  assert.equal(result.content, 'done');
  const [effortEvent, ...turns] = events;
  // No classifier on this provider, so `auto` degrades to the API default before the turn starts.
  assert.equal(effortEvent.type, 'effort');
  assert.equal(effortEvent.effort, 'high');
  assert.equal(effortEvent.source, 'fallback');
  assert.match(effortEvent.error, /completeJson is not a function/);
  assert.deepEqual(turns, [
    { type: 'phase', phase: 'thinking', step: 1 },
    { type: 'answer', delta: 'working', reset: false },
    { type: 'answer', delta: '', reset: true },
    { type: 'answer', delta: 'done', reset: false },
  ]);
});

test('runs a tool call that omits content and rejects one with no tool name', async () => {
  const { run, calls } = fixture([
    { toolCalls: [{ id: 'call_1', name: 'search_notes', args: {} }] },
    { content: 'done', toolCalls: [] },
  ]);
  await run();
  assert.equal(calls[0].name, 'search');
  await assert.rejects(fixture([{ toolCalls: [] }]).run(), /content is required/);
  await assert.rejects(
    fixture([{ content: 'x', toolCalls: [{ id: 'c', args: {} }] }]).run(),
    /tool name is required/,
  );
});

test('creates validated cards in the current deck unless a deck is specified, then reads them back', async () => {
  for (const deck of [undefined, 'Vocabulary']) {
    const { run, calls, records } = fixture([action('create_notes', { cards: [card], deck })]);
    await run();
    const created = calls.find(call => call.name === 'create');
    assert.equal(created.notes[0].deckName, deck || '_Todo');
    assert.equal(created.notes[0].fields.Term, 'test');
    assert.equal(calls.at(-1).name, 'notesInfo');
    assert.deepEqual(records.map(record => record.status), ['pending', 'completed']);
  }
});

test('lists collection tags and writes the matching tags beside each created card', async () => {
  const tags = ['domain::science', 'register::formal'];
  const { run, calls, records } = fixture([
    action('list_tags', {}),
    action('create_notes', { cards: [card], tags: [tags] }),
  ]);
  await run();
  assert.deepEqual(records.find(record => record.action.name === 'list_tags' && record.status === 'completed').result,
    { tags });
  assert.deepEqual(calls.find(call => call.name === 'create').notes[0].tags, tags);
});

test('rejects an invented card tag before attempting a collection write', async () => {
  const { run, calls, prompts } = fixture([
    action('create_notes', { cards: [card], tags: [['domain::invented']] }),
    action('create_notes', { cards: [card], tags: [['domain::science']] }),
  ]);
  await run();
  assert.equal(calls.filter(call => call.name === 'create').length, 1);
  assert.deepEqual(calls.find(call => call.name === 'create').notes[0].tags, ['domain::science']);
  assert.match(prompts[1].at(-1).content, /domain::invented/);
});

test('returns invalid card content to the agent for repair before writing', async () => {
  const repaired = { ...card, term: 'repaired' };
  const { run, calls, prompts, records } = fixture([
    action('create_notes', { cards: [{ term: 'bad' }] }),
    action('create_notes', { cards: [repaired] }),
  ]);
  await run();
  assert.equal(calls.find(call => call.name === 'create').notes[0].fields.Term, 'repaired');
  assert.deepEqual(records.map(entry => entry.status), ['pending', 'failed', 'pending', 'completed']);
  const feedback = JSON.parse(prompts[1].at(-1).content);
  assert.equal(feedback.collectionWriteAttempted, false);
  assert.match(feedback.error, /phonetic is required/);
});

test('reports card validation details after the agent exhausts safe repairs', async () => {
  const invalid = () => action('create_notes', { cards: [{ term: 'bad' }] });
  const { run, calls, records } = fixture([invalid(), invalid(), invalid()]);
  await assert.rejects(run(), error => {
    assert.match(error.userMessage, /after 3 attempts/);
    assert.match(error.userMessage, /cards\[0\]\.phonetic is required/);
    assert.match(error.userMessage, /before the write to Anki/);
    return true;
  });
  assert.deepEqual(calls, []);
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
});

test('reports when the agent stops instead of repairing invalid cards', async () => {
  const { run, calls } = fixture([
    action('create_notes', { cards: [{ term: 'bad' }] }),
    { content: 'I cannot supply the phonetic', toolCalls: [] },
  ]);
  await assert.rejects(run(), error => {
    assert.match(error.userMessage, /did not fix the cards/);
    assert.match(error.userMessage, /cards\[0\]\.phonetic is required/);
    assert.match(error.userMessage, /I cannot supply the phonetic/);
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
  assert.deepEqual(created.notes.map(note => note.fields.Term), ['apple', 'banana']);
  assert.deepEqual(new Set(created.notes.map(note => note.deckName)), new Set(['_Todo']));
  assert.equal(records.at(-1).status, 'completed');
});

test('requires one complete create_notes batch for a confirmed card family', async () => {
  const { run, tools, prompts } = fixture([{ content: 'ok', toolCalls: [] }]);
  await run();
  const create = tools[0].find(tool => tool.function.name === 'create_notes');
  assert.match(prompts[0][0].content, /send the complete set in one create_notes call/);
  assert.match(create.function.description, /complete requested card batch in one call/);
  assert.equal(create.function.parameters.properties.cards.maxItems, 50);
});

test('reports completed work and waits for consent at the configured request step limit', async () => {
  const { run, calls, prompts } = fixture([
    action('list_decks', {}), action('list_tags', {}), action('list_decks', {}), action('list_tags', {}),
    action('create_notes', { cards: [card] }),
  ], { stepLimit: 4 });
  const result = await run();

  assert.equal(result.stepLimitReached, true);
  assert.equal(result.stepLimit, 4);
  assert.equal(result.operations.length, 4);
  assert.match(result.content, /did not reach a final answer within this configuration's 4-step limit/);
  assert.match(result.content, /2 list_decks, 2 list_tags/);
  assert.match(result.content, /No further action was attempted/);
  assert.match(result.content, /Reply "Continue"/);
  assert.equal(prompts.length, 4);
  assert.equal(prompts.at(-1).some(message => /final allowed step/.test(message.content)), true);
  assert.equal(calls.some(call => call.name === 'create'), false);
});

// The tool the model is offered is the profile's own schema, so a note type the profile describes differently
// is written differently — there is no card shape in the agent itself.
test('offers create_notes with the configured profile\'s own card schema', async () => {
  const { run, tools, prompts } = fixture([{ content: 'ok', toolCalls: [] }]);
  await run();
  assert.deepEqual(tools[0].map(tool => tool.function.name),
    ['search_notes', 'read_notes', 'list_tags', 'create_notes', 'update_notes', 'delete_notes', 'list_decks',
      'read_card_profiles',
      'propose_card_profile', 'apply_card_profile']);
  const create = tools[0].find(tool => tool.function.name === 'create_notes');
  const schema = create.function.parameters.properties.cards.items;
  // The profile's own fields ARE the card, unchanged; the two keys in front of them only route it — which note
  // type it is written as and which deck it lands in — and neither is a field the profile has to know about.
  assert.deepEqual(Object.keys(schema.properties),
    ['noteType', 'deck', ...Object.keys(englishProfile.cardJsonSchema.properties)]);
  assert.deepEqual(schema.properties.noteType.enum, ['English']);
  assert.equal(schema.properties.deck.type, 'string');
  assert.deepEqual(Object.fromEntries(Object.entries(schema.properties)
    .filter(([name]) => name !== 'noteType' && name !== 'deck')), englishProfile.cardJsonSchema.properties);
  assert.deepEqual(schema.required, englishProfile.cardJsonSchema.required);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(create.function.parameters.properties.tags.items, {
    type: 'array', items: { type: 'string' }, maxItems: 5,
  });
  assert.match(prompts[0][0].content, /create_notes writes the user's own note types — English/);
});

test('validates and stores a card through the profile, not through a bundled one', async () => {
  const profile = compileProfile({ profile: 1, noteType: 'English',
    fields: [{ name: 'word', required: true }, { name: 'note' }],
    storage: [{ field: 'Front', of: 'word' }, { field: 'Back', of: 'note' }] });
  const { run, calls } = fixture([action('create_notes', { cards: [{ word: 'apple', note: 'a fruit' }] }),
    { content: 'ok', toolCalls: [] }], { cardProfiles: profileLibrary({ English: profile }) });
  await run();
  const created = calls.find(call => call.name === 'create');
  assert.deepEqual(created.notes[0].fields, { Front: 'apple', Back: 'a fruit' });
});

test('withholds create_notes and names the profile path when no note type has a profile', async () => {
  const { run, tools, prompts } = fixture([{ content: 'ok', toolCalls: [] }],
    { cardProfiles: profileLibrary({}) });
  await run();
  assert.deepEqual(tools[0].map(tool => tool.function.name),
    ['search_notes', 'read_notes', 'list_tags', 'update_notes', 'delete_notes', 'list_decks', 'read_card_profiles',
      'propose_card_profile', 'apply_card_profile']);
  assert.match(prompts[0][0].content, /No card profile is configured for the English note type/);
  assert.match(prompts[0][0].content, /\/tmp\/card-profiles\/English\.json/);
});

// The note type Settings names is a DEFAULT, the same kind of choice Anki's own new-note window pre-selects,
// and not the only note type a turn can write: every installed profile is offered, and a card names the one it
// is written as — so one call writes two note types, each to its own deck.
test('offers every installed note type and writes each card as the one it names', async () => {
  const phrase = compileProfile({ profile: 1, noteType: 'English Phrase',
    fields: [{ name: 'term', required: true }, { name: 'phrase', required: true }],
    storage: [{ field: 'Front', of: 'term' }, { field: 'Back', of: 'phrase' }] });
  const profiles = profileLibrary({ English: englishProfile, 'English Phrase': phrase });
  const { run, tools, calls, prompts } = fixture([action('create_notes', { cards: [
    card,
    { noteType: 'English Phrase', deck: 'Eng::Phrase', term: 'take a test', phrase: 'sit a test' },
  ] }), { content: 'ok', toolCalls: [] }], { cardProfiles: profiles });
  await run();
  const create = tools[0].find(tool => tool.function.name === 'create_notes');
  const schema = create.function.parameters.properties.cards.items;
  // One installed profile is a schema; several are a set of alternatives, the configured one first.
  assert.deepEqual(schema.anyOf.map(entry => entry.properties.noteType.enum), [['English'], ['English Phrase']]);
  assert.match(prompts[0][0].content, /create_notes writes the user's own note types — English, English Phrase/);
  assert.match(
    prompts[0][0].content,
    /A card that omits `noteType` is written as English, the note type this app is configured for/,
  );
  const created = calls.find(call => call.name === 'create');
  assert.deepEqual(created.notes.map(note => [note.modelName, note.deckName]),
    [['English', '_Todo'], ['English Phrase', 'Eng::Phrase']]);
  // The routing keys are read off the card before it is validated, so they never reach the profile's fields.
  assert.deepEqual(created.notes[1].fields, { Front: 'take a test', Back: 'sit a test' });
});

// A note type nobody configured a profile for has no card shape, so a card naming it is refused by name — and
// refused as the whole batch, the same guarantee an invalid field gets, because one card is never written
// without the others.
test('refuses a card that names a note type no profile describes, and writes nothing', async () => {
  const { run, calls, records } = fixture([
    action('create_notes', { cards: [card, { ...card, noteType: 'Japanese' }] }),
    { content: 'no such note type', toolCalls: [] },
  ]);
  await assert.rejects(run(), error => {
    assert.match(error.userMessage, /cards\[1\]\.noteType has no card profile: Japanese \(installed: English\)/);
    return true;
  });
  assert.deepEqual(calls, []);
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
});

test('answers a create_notes call made without a profile instead of writing', async () => {
  const { run, calls, records } = fixture([
    action('create_notes', { cards: [card] }),
    { content: 'a profile must be created first', toolCalls: [] },
  ], { cardProfiles: profileLibrary({}) });
  const reply = await run();
  assert.equal(calls.some(call => call.name === 'create'), false);
  const answered = records.find(entry => entry.status === 'completed');
  assert.match(answered.result.error, /No card profile is configured/);
  assert.match(answered.result.instruction, /\/tmp\/card-profiles\/English\.json/);
  assert.equal(reply.content, 'a profile must be created first');
});

test('the factory prompt carries the tool contract and none of the user\'s own conventions', async () => {
  const { run, prompts, tools } = fixture([{ content: 'ok', toolCalls: [] }]);
  await run();
  const system = prompts[0][0].content;
  assert.match(system, /through the provided tools/);
  assert.match(system, /create_notes validation errors write nothing/);
  assert.match(system, /"Continue" resumes only recorded unfinished work/);
  // Bare words, lists, the default deck and the reply language are standing instructions now, so a fresh
  // install must not answer them from a hardcoded default.
  assert.doesNotMatch(system, /bare English word, phrase, or idiom/);
  assert.doesNotMatch(system, /Split lists longer than 50 items/);
  assert.doesNotMatch(system, /Default new notes to Anki's current deck/);
  assert.doesNotMatch(system, /Reply in Traditional Chinese/);
  // This app's own template field names and separators live in the card contract and the tool schema, so a
  // fresh install must not read them off the factory prompt as though they were the user's own note type.
  assert.doesNotMatch(system, /TermUS|TypeLabel|Implications|Correlations/);
  assert.match(system, /never JSON/);
  assert.deepEqual(tools[0].map(tool => tool.function.name),
    ['search_notes', 'read_notes', 'list_tags', 'create_notes', 'update_notes', 'delete_notes', 'list_decks',
      'read_card_profiles',
      'propose_card_profile', 'apply_card_profile']);
});

// A selection narrows a read without ever taking the id away: the ledger is keyed on it, and a later write
// depends on it being there.
test('answers only the fields a read selected and always keeps the id', async () => {
  const { run, calls, records } = fixture([
    action('search_notes', { query: 'deck:English', select: 'fieldValues' }),
    action('read_notes', { ids: [12], select: ['fields'] }),
    action('list_decks', { select: 'currentDeck' }),
    { content: 'ok', toolCalls: [] },
  ]);
  await run();
  assert.deepEqual(calls.find(call => call.name === 'search').args.select, ['id', 'fieldValues']);
  const read = records.find(record => record.action.name === 'read_notes' && record.status === 'completed');
  assert.deepEqual(Object.keys(read.result.notes[0]), ['noteId', 'fields']);
  const decks = records.find(record => record.action.name === 'list_decks' && record.status === 'completed');
  assert.deepEqual(decks.result, { currentDeck: '_Todo' });
});

// Which fields a row can carry is a fact about this app, so a selection the model invented is answered with
// the list to choose from instead of ending the turn.
test('answers an invented select instead of failing the turn', async () => {
  const { run, records } = fixture([action('search_notes', { select: 'nope' }), { content: 'ok', toolCalls: [] }]);
  await run();
  const refused = records.find(record => record.status === 'completed');
  assert.match(refused.result.error,
    /^select must be one of: id, fieldValues, sortField, modelName, tags, createdAt, deckName, dueAt, flag,/);
  assert.match(refused.result.instruction, /omit select/);
});

// The audit reads the note type it is judging instead of assuming this app's own field names, so the shape has
// to be answerable as data: the profile, with every default the compiler applied written out. One call carries
// every note type it named, so a turn auditing two of them learns both without a second call.
test('answers a card profile read with the note type\'s own fields and rules', async () => {
  const { run, records } = fixture([
    action('read_card_profiles', { noteTypes: ['English'] }),
    { content: 'ok', toolCalls: [] },
  ]);
  await run();
  const answered = records.find(entry => entry.status === 'completed');
  const [profile] = answered.result.profiles;
  assert.equal(profile.noteType, 'English');
  assert.deepEqual(profile.fields.map(field => field.name), englishProfile.fields);
  assert.deepEqual(profile.storage.filter(entry => entry.of.includes('meaning')),
    [{ field: 'Meaning', of: ['meaning', 'translation'], join: '<br>' }]);
  assert.deepEqual(profile.fields.filter(field => field.required).map(field => field.name),
    ['meaning', 'translation', 'term', 'type']);
  assert.deepEqual(profile.fields.find(field => field.name === 'literal').requiredWhen,
    { field: 'type', in: 'phrase', message: 'for idioms and phrasal verbs' });
});

// A turn that judges two note types asks once, and one name it got wrong does not cost it the answer to the
// other: the miss is answered in place, with the installed list and where a profile for it belongs.
test('answers several note types in one call, a missing one by name', async () => {
  const phrase = compileProfile({ profile: 1, noteType: 'English Phrase',
    fields: [{ name: 'term', required: true }], storage: [{ field: 'Front', of: 'term' }] });
  const { run, records } = fixture([
    action('read_card_profiles', { noteTypes: ['English', 'Japanese', 'English Phrase'] }),
    { content: 'ok', toolCalls: [] },
  ], { cardProfiles: profileLibrary({ English: englishProfile, 'English Phrase': phrase }) });
  await run();
  const answered = records.find(entry => entry.status === 'completed');
  assert.deepEqual(answered.result.profiles.map(profile => profile.noteType),
    ['English', 'Japanese', 'English Phrase']);
  assert.match(answered.result.profiles[1].error, /No card profile is installed for the Japanese note type/);
  assert.deepEqual(answered.result.profiles[1].noteTypes, ['English', 'English Phrase']);
  assert.equal(answered.result.profiles[1].path, '/tmp/card-profiles/Japanese.json');
  assert.deepEqual(answered.result.profiles[2].fields.map(field => field.name), ['term']);
});

// Naming nothing is how a caller learns what it may name, so it lists the installed profiles instead of
// silently answering for one note type.
test('lists the installed profiles when no note type is named', async () => {
  const { run, records } = fixture([action('read_card_profiles', {}), { content: 'ok', toolCalls: [] }]);
  await run();
  const answered = records.find(entry => entry.status === 'completed');
  assert.deepEqual(answered.result, { noteTypes: ['English'] });
});

test('withholds the card profile tool when no profiles directory is configured', async () => {
  const { run, tools } = fixture([{ content: 'ok', toolCalls: [] }], { cardProfiles: null });
  await run();
  assert.deepEqual(tools[0].map(tool => tool.function.name),
    ['search_notes', 'read_notes', 'list_tags', 'update_notes', 'delete_notes', 'list_decks']);
});

test('searches lightweight rows with a bounded default limit and can list decks', async () => {
  const { run, calls } = fixture([
    action('search_notes', {}), action('list_decks', {}), { content: 'ok', toolCalls: [] },
  ]);
  await run();
  assert.equal(calls[0].name, 'search');
  assert.equal(calls[0].args.query, '-nid:0');
  assert.equal(calls[0].args.limit, 50);
  const bounded = fixture([
    action('search_notes', { query: 'deck:English', limit: 5 }), { content: 'ok', toolCalls: [] },
  ]);
  await bounded.run();
  assert.equal(bounded.calls[0].args.limit, 5);
  assert.equal(bounded.calls[0].args.query, 'deck:English');
  assert.ok(calls.some(call => call.name === 'currentDeckName'));
});
test('names the unknown field and the valid ones so the agent can repair the update', async () => {
  const { run } = fixture([
    action('read_notes', { ids: [12] }),
    action('update_notes', { notes: [{ id: 12, fields: { Meaning: 'x', Nope: 'y' } }] }),
  ]);
  await assert.rejects(run(), /Unknown note field Nope; this note has: Term, Meaning/);
  const empty = fixture([
    action('read_notes', { ids: [12] }),
    action('update_notes', { notes: [{ id: 12, fields: {} }] }),
  ]);
  await assert.rejects(empty.run(), /fields must name at least one changed field/);
});

test('replaces tags and moves every card of an already-read note without changing its fields', async () => {
  const { run, calls, records, tools } = fixture([
    action('read_notes', { ids: [12] }),
    action('update_notes', { notes: [{ id: 12, tags: ['register::formal'], deck: 'English' }] }),
  ]);
  await run();

  const update = tools[0].find(tool => tool.function.name === 'update_notes')
    .function.parameters.properties.notes.items;
  assert.deepEqual(update.required, ['id']);
  assert.deepEqual(update.anyOf, [{ required: ['fields'] }, { required: ['tags'] }, { required: ['deck'] }]);
  assert.equal(update.properties.tags.maxItems, 50);
  assert.equal(update.properties.deck.type, 'string');
  assert.deepEqual(calls.find(call => call.name === 'update-tags').args,
    { add: ['register::formal'], remove: ['domain::science'] });
  assert.deepEqual(calls.find(call => call.name === 'change-deck').args, { noteIds: [12], deck: 'English' });
  const completed = records.find(record => record.action.name === 'update_notes' && record.status === 'completed');
  const result = completed.result.notes[0];
  assert.deepEqual(result.before.tags, ['domain::science']);
  assert.deepEqual(result.after.tags, ['register::formal']);
  assert.equal(result.after.deckName, 'English');
  assert.equal(calls.some(call => call.name === 'update'), false);
});

test('validates target tags and decks before an update batch writes anything', async () => {
  const badTag = fixture([
    action('read_notes', { ids: [12] }),
    action('update_notes', { notes: [{ id: 12, fields: { Meaning: 'new' }, tags: ['invented'] }] }),
  ]);
  await assert.rejects(badTag.run(), /tags must use existing collection tags: invented/);
  assert.equal(badTag.calls.some(call => ['update', 'update-tags', 'change-deck'].includes(call.name)), false);

  const badDeck = fixture([
    action('read_notes', { ids: [12] }),
    action('update_notes', { notes: [{ id: 12, fields: { Meaning: 'new' }, deck: 'Missing' }] }),
  ]);
  await assert.rejects(badDeck.run(), /Unknown deck: Missing/);
  assert.equal(badDeck.calls.some(call => ['update', 'update-tags', 'change-deck'].includes(call.name)), false);
});

test('searches all decks and requires reading exact IDs before update/delete', async () => {
  const { run, calls, records } = fixture([
    action('search_notes', { query: '' }), action('read_notes', { ids: [12] }),
    action('update_notes', { notes: [{ id: 12, fields: { Meaning: 'new' } }] }), action('delete_notes', { ids: [12] }),
  ]);
  await run();
  assert.equal(calls[0].args.query, '-nid:0');
  const updated = records.find(record => record.action.name === 'update_notes' && record.status === 'completed');
  assert.equal(updated.result.notes[0].before.fields.Meaning.value, 'old');
  assert.equal(updated.result.notes[0].after.fields.Meaning.value, 'new');
  assert.equal(calls.at(-1).name, 'delete');
  const unread = fixture([action('delete_notes', { ids: [99] })]);
  await assert.rejects(unread.run(), /Read the target/);
  assert.deepEqual(unread.calls, []);
});


test('reads, updates and deletes several notes in one call each', async () => {
  const f = batchFixture([
    action('read_notes', { ids: [12, 13, 99] }),
    action('update_notes', { notes: [
      { id: 12, fields: { Meaning: 'new' } },
      { id: 13, fields: { Meaning: 'new2' } },
    ] }),
    action('delete_notes', { ids: [12, 13] }),
    { content: 'done', toolCalls: [] },
  ]);
  const { operations } = await f.run();
  const read = operations.find(operation => operation.action.name === 'read_notes');
  assert.deepEqual(read.result.notes.map(note => note.noteId), [12, 13, 99]);
  assert.match(read.result.notes[2].error, /Note not found/);
  const update = operations.find(operation => operation.action.name === 'update_notes');
  assert.deepEqual(update.result.notes.map(entry => [entry.id, entry.after.fields.Meaning.value]),
    [[12, 'new'], [13, 'new2']]);
  const remove = operations.find(operation => operation.action.name === 'delete_notes');
  assert.deepEqual(remove.result.notes.map(entry => entry.id), [12, 13]);
  assert.deepEqual(f.calls.filter(call => call.name === 'delete').map(call => call.id), [12, 13]);
});

// A batch is one edit the user asked for, so an entry that cannot be checked stops the whole call before the
// first write: nothing is left half-updated for a retry to read.
test('an update batch that names an unread note changes nothing', async () => {
  const f = batchFixture([
    action('read_notes', { ids: [12] }),
    action('update_notes', { notes: [
      { id: 12, fields: { Meaning: 'new' } },
      { id: 13, fields: { Meaning: 'x' } },
    ] }),
  ]);
  await assert.rejects(f.run(), /Read the target note before changing it: note 13 was not read/);
  assert.deepEqual(f.calls.filter(call => call.name === 'update'), []);
});

test('a note a read batch could not find grants no credit for a later write', async () => {
  const f = batchFixture([
    action('read_notes', { ids: [12, 99] }),
    action('update_notes', { notes: [{ id: 99, fields: { Meaning: 'x' } }] }),
  ]);
  await assert.rejects(f.run(), /Read the target note before changing it: note 99 was not read/);
  assert.deepEqual(f.calls.filter(call => call.name === 'update'), []);
});

test('refuses a batch that names no note or more notes than the cap', async () => {
  const empty = batchFixture([action('delete_notes', { ids: [] })]);
  await assert.rejects(empty.run(), /ids must name at least one note/);
  const oversized = batchFixture([action('read_notes', { ids: Array.from({ length: 51 }, (_, index) => index + 1) })]);
  await assert.rejects(oversized.run(), /ids must name at most 50 notes/);
  assert.deepEqual(oversized.calls, []);
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
  const { run, prompts } = fixture([{ content: 'ok', toolCalls: [] }]);
  await run({ selectionNoteIds: [12, 34] });
  assert.equal(prompts[0][1].role, 'user');
  assert.match(prompts[0][1].content, /12, 34/);
  const empty = fixture([{ content: 'ok', toolCalls: [] }]);
  await empty.run();
  assert.equal(empty.prompts[0][1].content, 'request');
});
