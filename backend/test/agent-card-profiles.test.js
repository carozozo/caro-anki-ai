const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AnkiAgent } = require('../anki-agent');
const { CardProfileLibrary } = require('../card-profile-library');

const sampleProfile = (noteType, wordField = 'word') => ({
  profile: 1,
  noteType,
  fields: [
    { name: wordField, required: true },
    { name: 'meaning', required: true },
  ],
  storage: [
    { field: 'Front', of: wordField },
    { field: 'Back', of: 'meaning' },
  ],
});

// The profile an edit is asked to touch without being asked to restate it: everything an edit does not name —
// the version and the groups here — has to come out of it exactly as it went in.
const labeled = noteType => ({
  profile: 1,
  noteType,
  version: '1.6',
  groups: { phrase: ['idiom'] },
  fields: [
    { name: 'term', required: true },
    { name: 'typeLabel', enum: ['C', 'C or U'], enumMode: 'labels', guidance: 'Pick from {values}.' },
  ],
  storage: [
    { field: 'Front', of: 'term' },
    { field: 'Type', of: 'typeLabel' },
  ],
});

// A real library over a real directory, because what a profile write is worth is whether the next turn reads
// the profile it wrote.
const fixture = (t, { profiles = { 'English.json': labeled('English') }, replies = [] } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caro-agent-card-profiles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, profile] of Object.entries(profiles)) {
    fs.writeFileSync(path.join(dir, name), `${JSON.stringify(profile, null, 2)}\n`);
  }
  const cardProfiles = new CardProfileLibrary({ dir });
  cardProfiles.initialize();

  const prompts = [];
  const offered = [];
  const records = [];
  const queue = [...replies];
  const agent = new AnkiAgent({
    browser: {}, client: {}, config: { modelName: 'English' }, cardProfiles,
    provider: {
      completeWithTools: async ({ messages, tools }) => {
        prompts.push(structuredClone(messages));
        offered.push(tools);
        return queue.shift() || { content: 'ok', toolCalls: [] };
      },
    },
  });
  return { run: () => agent.respond({ messages: [{ role: 'user', content: 'request' }],
      record: operation => records.push(structuredClone(operation)) }),
    prompts, offered, records, dir, cardProfiles };
};
const stored = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

const proposeChange = args => ({ content: 'a proposal',
  toolCalls: [{ id: 'call_1', name: 'propose_card_profile', args }] });
const applyChange = args => ({ content: 'written',
  toolCalls: [{ id: 'call_1', name: 'apply_card_profile', args }] });

// The authoring rules are part of the one system turn and they ride with the tools they describe: a turn that
// can write a profile is a turn that must be told a proposal writes nothing.
test('the profile authoring prompt rides with the profile tools', async t => {
  const { run, prompts, offered } = fixture(t);
  await run();
  assert.deepEqual(prompts[0].map(message => message.role), ['system', 'user']);
  assert.match(prompts[0][0].content, /apply_card_profile is the only write/);
  assert.match(prompts[0][0].content, /Never call a proposed change saved or paste its body in your reply/);
  assert.match(prompts[0][0].content, /create_notes writes the user's own note types — English/);
  assert.deepEqual(offered[0].map(tool => tool.function.name),
    ['search_notes', 'read_notes', 'list_tags', 'create_notes', 'update_notes', 'delete_notes', 'list_decks', 'read_card_profiles',
      'propose_card_profile', 'apply_card_profile']);
});

// A whole profile is a file the user has to read, so the proposal answers the text that would land — checked by
// the grammar and serialized by the library — and the directory is exactly as it was.
test('a proposed profile is reported as not written and leaves the directory alone', async t => {
  const { run, prompts, dir } = fixture(t, {
    replies: [proposeChange({ profiles: [{ noteType: 'Japanese', profile: sampleProfile('Japanese', 'spelling') }] })],
  });
  const result = await run();
  assert.equal(result.content, 'ok');
  assert.deepEqual(result.operations.map(operation => operation.status), ['completed']);
  const [entry] = result.operations[0].result.profiles;
  assert.deepEqual({ ...entry, bytes: 0, content: '' },
    { name: 'Japanese.json', noteType: 'Japanese', bytes: 0, content: '', exists: false });
  assert.equal(entry.bytes, Buffer.byteLength(entry.content));
  assert.deepEqual(JSON.parse(entry.content), sampleProfile('Japanese', 'spelling'));
  assert.deepEqual({ ...result.operations[0].result, profiles: [] },
    { proposed: true, written: false, profiles: [], renames: [], removals: [] });
  assert.deepEqual(fs.readdirSync(dir), ['English.json']);
  // The model is handed the proposal back, so its reply can describe a file that really is about to exist.
  assert.match(prompts[1].at(-1).content, /"written":false/);
});

// An edit is the operation a profile mostly needs, and the proposal answers the keys it would change plus the
// file that edit produces — which is the only way a reader can judge a change they did not spell out.
test('a proposed edit answers the keys it would change and the file it would produce', async t => {
  const { run, dir } = fixture(t, {
    replies: [proposeChange({ profiles: [{ noteType: 'English',
      edit: { field: 'typeLabel', set: { enum: ['C', 'C or U', 'usually plural'] } } }] })],
  });
  const result = await run();
  const [entry] = result.operations[0].result.profiles;
  assert.deepEqual({ field: entry.field, changes: entry.changes, exists: entry.exists },
    { field: 'typeLabel', changes: ['set typeLabel.enum'], exists: undefined });
  const written = JSON.parse(entry.content);
  assert.deepEqual(written.fields[1].enum, ['C', 'C or U', 'usually plural']);
  assert.equal(written.version, '1.6');
  assert.deepEqual(written.groups, { phrase: ['idiom'] });
  assert.deepEqual(stored(dir, 'English.json').fields[1].enum, ['C', 'C or U']);
});

// A rename follows the note type rather than the file, so the answer names the note type it would become and
// moves nothing.
test('a proposed rename answers the note type it would become without moving the file', async t => {
  const { run, dir } = fixture(t, {
    replies: [proposeChange({ renames: [{ name: 'English', to: 'Vocab Card' }] })],
  });
  const result = await run();
  const [entry] = result.operations[0].result.renames;
  assert.deepEqual({ name: entry.name, to: entry.to, noteType: entry.noteType, renamed: entry.renamed },
    { name: 'English.json', to: 'Vocab Card.json', noteType: 'English', renamed: 'Vocab Card' });
  assert.equal(JSON.parse(entry.content).noteType, 'Vocab Card');
  assert.deepEqual(fs.readdirSync(dir), ['English.json']);
  assert.equal(stored(dir, 'English.json').noteType, 'English');
});

// Retiring a profile is one of the smallest changes here and the one with the widest reach, since it is what
// stops create_notes for that note type.
test('a proposed removal names the profile it would retire and keeps it', async t => {
  const { run, dir } = fixture(t, { replies: [proposeChange({ removals: ['English'] })] });
  const result = await run();
  const [entry] = result.operations[0].result.removals;
  assert.deepEqual({ name: entry.name, noteType: entry.noteType }, { name: 'English.json', noteType: 'English' });
  assert.equal(entry.bytes, Buffer.byteLength(fs.readFileSync(path.join(dir, 'English.json'), 'utf8')));
  assert.deepEqual(fs.readdirSync(dir), ['English.json']);
});

// A profile the grammar refuses is the model's mistake to correct in this same turn, so the grammar's own
// sentence comes back with the instruction that names the tool — and nothing is attempted on disk.
test('a proposed profile the grammar refuses is answered, not thrown', async t => {
  const { run, prompts, records, dir } = fixture(t, {
    replies: [proposeChange({ profiles: [{ noteType: 'Japanese',
      profile: { ...sampleProfile('Japanese', 'spelling'), storage: [{ field: 'Front', of: 'spelling' }] } }] })],
  });
  const result = await run();
  assert.equal(result.content, 'ok');
  const { result: answered } = result.operations[0];
  assert.deepEqual([answered.proposed, answered.written, answered.profiles], [false, false, []]);
  assert.match(answered.error, /field meaning is not stored/);
  assert.equal(answered.instruction,
    'Correct the refused change and call propose_card_profile again with the whole profile.');
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
  assert.deepEqual(fs.readdirSync(dir), ['English.json']);
  assert.match(prompts[1].at(-1).content, /is not stored/);
});

// A call that names nothing has nothing to propose, and saying so is cheaper than a proposal of nothing.
test('a proposal that names nothing is answered, not thrown', async t => {
  const { run, records } = fixture(t, { replies: [proposeChange({})] });
  const result = await run();
  assert.equal(result.operations[0].status, 'completed');
  assert.deepEqual(result.operations[0].result, { proposed: false, written: false, profiles: [], renames: [],
    removals: [], error: 'nothing was proposed: name at least one profile to write, edit, rename or remove',
    instruction: 'Call propose_card_profile again with the change the user asked for.' });
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
});

// The write is the proposal's second half, and because the library refreshes itself the profile is live for
// the rest of the turn: the note type the agent could not write a card for a moment ago now compiles.
test('an applied profile is written and read back by the same turn', async t => {
  const { run, prompts, dir, cardProfiles } = fixture(t, {
    replies: [applyChange({ profiles: [{ noteType: 'Japanese', profile: sampleProfile('Japanese', 'spelling') }] })],
  });
  const result = await run();
  const { result: applied } = result.operations[0];
  assert.deepEqual({ ...applied, profiles: [] },
    { applied: true, profiles: [], renames: [], removals: [] });
  assert.deepEqual({ ...applied.profiles[0], bytes: 0 },
    { name: 'Japanese.json', noteType: 'Japanese', bytes: 0, created: true, backup: '' });
  assert.equal(applied.profiles[0].bytes, Buffer.byteLength(fs.readFileSync(path.join(dir, 'Japanese.json'), 'utf8')));
  assert.equal(cardProfiles.get('Japanese').noteType, 'Japanese');
  assert.equal(cardProfiles.errors().length, 0);
  assert.match(prompts[1].at(-1).content, /"applied":true/);
});

// An edit is the operation that must not restate a profile, so what it does not name has to survive the write:
// the version, the groups and the other field all land exactly as they were, and the text it replaced is kept.
test('an applied edit changes only what the edit names', async t => {
  const { run, dir, cardProfiles } = fixture(t, {
    replies: [applyChange({ profiles: [{ noteType: 'English',
      edit: { field: 'typeLabel', set: { enum: ['C', 'C or U', 'usually plural'] } } }] })],
  });
  const result = await run();
  const { result: applied } = result.operations[0];
  assert.deepEqual(applied.profiles[0].changes, ['set typeLabel.enum']);
  assert.match(applied.profiles[0].backup, /^versions\/English\.json\./);
  const profile = stored(dir, 'English.json');
  assert.deepEqual(profile.fields[1].enum, ['C', 'C or U', 'usually plural']);
  assert.deepEqual([profile.version, profile.groups], ['1.6', { phrase: ['idiom'] }]);
  assert.deepEqual(cardProfiles.get('English').spec('typeLabel').enum, ['C', 'C or U', 'usually plural']);
});

// One call carries the whole change, so a note type that was renamed and a profile that is no longer wanted
// are two files in one answer, each keeping the text it had.
test('one applied call can rename a profile with its note type and retire another', async t => {
  const { run, dir, cardProfiles } = fixture(t, {
    profiles: { 'English.json': labeled('English'), 'Old.json': sampleProfile('Old') },
    replies: [applyChange({ renames: [{ name: 'English', to: 'Vocab Card' }], removals: ['Old'] })],
  });
  const result = await run();
  const { result: applied } = result.operations[0];
  assert.deepEqual({ name: applied.renames[0].name, to: applied.renames[0].to,
    noteType: applied.renames[0].noteType, renamed: applied.renames[0].renamed },
  { name: 'English.json', to: 'Vocab Card.json', noteType: 'English', renamed: 'Vocab Card' });
  assert.match(applied.renames[0].backup, /^versions\/English\.json\./);
  assert.deepEqual({ name: applied.removals[0].name, noteType: applied.removals[0].noteType },
    { name: 'Old.json', noteType: 'Old' });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Vocab Card.json', 'versions']);
  assert.equal(stored(dir, 'Vocab Card.json').noteType, 'Vocab Card');
  assert.equal(cardProfiles.get('Vocab Card').noteType, 'Vocab Card');
  assert.equal(cardProfiles.get('English'), null);
});

// A refusal part-way through is the one thing the model must not rerun, so the answer names what already
// landed and tells it that those changes are written.
test('a refusal part-way through an applied call reports what already landed', async t => {
  const { run, records, dir } = fixture(t, {
    replies: [applyChange({ profiles: [{ noteType: 'Japanese', profile: sampleProfile('Japanese', 'spelling') }],
      removals: ['Missing'] })],
  });
  const result = await run();
  const { result: applied } = result.operations[0];
  assert.deepEqual([applied.applied, applied.profiles.length, applied.removals], [false, 1, []]);
  assert.match(applied.error, /no card profile for the Missing note type/);
  assert.equal(applied.instruction, 'The changes this result lists are written; do not apply them again.');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['English.json', 'Japanese.json']);
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
});

// A change the library refuses writes nothing, so the turn is not a write of unknown outcome — while a
// directory the app cannot write to is exactly that, and the record has to admit it.
test('a failed apply is recorded as a write whose outcome is unknown', async t => {
  const { run, records, dir } = fixture(t, {
    replies: [applyChange({ profiles: [{ noteType: 'Japanese', profile: sampleProfile('Japanese', 'spelling') }] })],
  });
  if (process.getuid?.() === 0 || process.platform === 'win32') return;
  fs.chmodSync(dir, 0o500);
  try {
    await assert.rejects(run, error => error.code === 'EACCES');
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.deepEqual([records.at(-1).status, records.at(-1).outcomeUnknown], ['failed', true]);
});
