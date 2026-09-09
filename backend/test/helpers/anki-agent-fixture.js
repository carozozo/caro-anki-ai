const path = require('node:path');
const { AnkiAgent } = require('../../anki-agent');
const { englishProfile, profileLibrary } = require('./profile-fixture');
const { AgentChat } = require('../../agent-chat');
const { createDatabase } = require('../../../sqlite/database');
const Repository = require('../../../sqlite/repository');

const card = { term: 'test', meaning: 'an examination', type: 'noun', typeLabel: 'C',
  translation: '測試', implications: ['考試', '測驗', '檢查'], phonetic: '/test/',
  examples: [{ en: 'Take a test.', zh: '參加測驗。' }] };
let callId = 0;
const action = (name, args) => ({ content: name, toolCalls: [{ id: `call_${++callId}`, name, args }] });
const fixture = (replies, options = {}) => {
  const calls = [];
  const records = [];
  const note = {
    noteId: 12, tags: ['domain::science'], fields: { Term: { value: 'test' }, Meaning: { value: 'old' } },
  };
  let deckName = '_Todo';
  const client = {
    addNotes: async notes => { calls.push({ name: 'create', notes }); return [12]; },
    invoke: async (name, args) => {
      calls.push({ name, args });
      if (name === 'currentDeckName') return '_Todo';
      if (name === 'getTags') return ['domain::science', 'register::formal'];
      if (name === 'browserNoteInfo') return { ...structuredClone(note), deckName };
      // One entry per requested id, the way the bridge answers, so a batch read of several ids is not collapsed
      // into the one note this fixture's collection holds.
      if (name === 'notesInfo') return (args.notes || []).map(() => structuredClone(note));
      return [structuredClone(note)];
    },
  };
  const browser = {
    searchRows: async args => {
      calls.push({ name: 'search', args });
      return { query: args.query, total: 1, hasMore: false, notes: [{ id: 12, fieldValues: { Term: 'test' } }] };
    },
    meta: async () => ({ decks: ['_Todo', 'English'], models: ['English'] }),
    updateNote: async (id, args) => {
      calls.push({ name: 'update', id, args });
      note.fields.Meaning.value = args.fields.Meaning;
    },
    updateNoteTags: async (id, { add, remove }) => {
      calls.push({ name: 'update-tags', id, args: { add, remove } });
      note.tags = [...note.tags.filter(tag => !remove.includes(tag)), ...add.filter(tag => !note.tags.includes(tag))];
    },
    batchChangeDeck: async ({ noteIds, deck }) => {
      calls.push({ name: 'change-deck', args: { noteIds, deck } });
      deckName = deck;
    },
    deleteNote: async id => calls.push({ name: 'delete', id }),
  };
  const prompts = [];
  const tools = [];
  const efforts = [];
  const classifications = [];
  const agent = new AnkiAgent({
    browser,
    client,
    cardProfiles: profileLibrary({ English: englishProfile }),
    ...options,
    config: { modelName: 'English', allowDuplicate: true },
    provider: {
      completeWithTools: async ({ messages, tools: offered, reasoningEffort }) => {
        prompts.push(structuredClone(messages));
        tools.push(offered);
        efforts.push(reasoningEffort);
        return replies.shift() || { content: 'done', toolCalls: [] };
      },
      // The `auto` classifier rides on the same provider; its own call is recorded separately so a test can
      // tell the routing decision apart from the turn it routed.
      completeJson: async ({ messages }) => {
        classifications.push(structuredClone(messages));
        return { effort: 'high' };
      },
    },
  });
  const run = (options = {}) => agent.respond({ messages: [{ role: 'user', content: 'request' }],
    record: operation => records.push(structuredClone(operation)), ...options });
  return { agent, run, calls, records, client, prompts, tools, efforts, classifications };
};

// A collection with more than one note, so a batch is exercised against distinct ids rather than the single
// note the shared fixture holds — and a note the collection does not have is answered in place.
const batchFixture = replies => {
  const calls = [];
  const notes = new Map([
    [12, { noteId: 12, fields: { Term: { value: 'test' }, Meaning: { value: 'old' } } }],
    [13, { noteId: 13, fields: { Term: { value: 'quiz' }, Meaning: { value: 'old2' } } }],
  ]);
  const client = {
    addNotes: async () => [],
    invoke: async (name, args) => {
      calls.push({ name, args });
      if (name === 'currentDeckName') return '_Todo';
      if (name === 'getTags') return [];
      if (name === 'notesInfo') return (args.notes || []).map(id => {
        const note = notes.get(Number(id));
        return note ? structuredClone(note) : null;
      });
      return [];
    },
  };
  const browser = {
    searchRows: async () => ({ query: '', total: 0, hasMore: false, notes: [] }),
    meta: async () => ({ decks: [], models: [] }),
    updateNote: async (id, { fields }) => {
      calls.push({ name: 'update', id, args: { fields } });
      Object.assign(notes.get(Number(id)).fields,
        Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, { value }])));
    },
    deleteNote: async id => { calls.push({ name: 'delete', id }); notes.delete(Number(id)); },
  };
  const agent = new AnkiAgent({
    browser,
    client,
    cardProfiles: profileLibrary({ English: englishProfile }),
    config: { modelName: 'English', allowDuplicate: true },
    provider: { completeWithTools: async () => replies.shift() || { content: 'done', toolCalls: [] } },
  });
  return { calls,
    run: () => agent.respond({ messages: [{ role: 'user', content: 'request' }], record: () => {} }) };
};

const chatFixture = t => {
  const db = createDatabase({
    dbPath: ':memory:', migrationsDir: path.resolve(__dirname, '../../../sqlite/migrations'),
  });
  t.after(() => db.close());
  const repository = new Repository(db);
  const session = repository.createSession();
  let attempts = 0;
  const received = [];
  const agent = {
    respond: async args => {
      attempts++;
      received.push(args);
      return { content: 'done', operations: [] };
    },
  };
  return { db, repository, session, agent, received, attempts: () => attempts,
    chat: new AgentChat({ db, repository, agent }) };
};

module.exports = { action, batchFixture, card, chatFixture, fixture };
