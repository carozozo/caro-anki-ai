const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AnkiAgent } = require('../anki-agent');
const { skillFixture } = require('./helpers/skill-fixture');
const { englishProfiles } = require('./helpers/profile-fixture');
const { InstructionLibrary } = require('../instruction-library');

// The prompt's ORDER is the contract: the factory prompt settles what the agent is and what its tools do,
// the user's standing instructions come next, and a skill catalogue comes last because a skill is a
// load-on-demand procedure rather than a standing preference.
const BASE_TOOLS = ['search_notes', 'read_note', 'create_notes', 'update_note', 'delete_note', 'list_decks',
  'read_card_profile', 'propose_card_profile', 'apply_card_profile'];
// An instructions library is what makes the proposal tool exist, and the tool that writes what a proposal
// showed rides with it, so both come with the six above.
const INSTRUCTION_TOOLS = [...BASE_TOOLS, 'propose_instructions', 'apply_instructions'];

const fixture = (t, { instructions = [], skills = false, replies = [] } = {}) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caro-agent-instructions-')), 'instructions');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const library = new InstructionLibrary({ dir });
  library.initialize();
  for (const [name, content] of instructions) fs.writeFileSync(path.join(dir, name), content);

  const prompts = [];
  const offered = [];
  const records = [];
  const queue = [...replies];
  const agent = new AnkiAgent({
    browser: {}, client: {}, config: { modelName: 'English' }, instructions: library,
    skills: skills ? skillFixture(t) : null, cardProfiles: englishProfiles,
    provider: {
      completeWithTools: async ({ messages, tools }) => {
        prompts.push(structuredClone(messages));
        offered.push(tools);
        return queue.shift() || { content: '好', toolCalls: [] };
      },
    },
  });
  return { run: () => agent.respond({ messages: [{ role: 'user', content: 'request' }],
      record: operation => records.push(structuredClone(operation)) }),
    prompts, offered, records, dir, library };
};
test('with no instruction files the prompt is unchanged', async t => {
  const { run, prompts } = fixture(t);
  await run();
  assert.deepEqual(prompts[0].map(message => message.role), ['system', 'user']);
});

test('an instruction file is injected as its own system message after the factory prompt', async t => {
  const { run, prompts } = fixture(t, { instructions: [['language.md', 'Always answer in English.']] });
  await run();
  assert.deepEqual(prompts[0].map(message => message.role), ['system', 'system', 'user']);
  assert.match(prompts[0][0].content, /You operate the user's Anki through the provided tools/);
  assert.doesNotMatch(prompts[0][0].content, /Always answer in English/);
  assert.match(prompts[0][1].content, /^## User instructions/);
  assert.match(prompts[0][1].content, /### language\.md\nAlways answer in English\./);
});

test('instructions come before the skill catalogue', async t => {
  const { run, prompts } = fixture(t, {
    skills: true, instructions: [['style.md', 'One sense per card.']],
  });
  await run();
  assert.deepEqual(prompts[0].map(message => message.role), ['system', 'system', 'system', 'user']);
  assert.match(prompts[0][1].content, /One sense per card\./);
  assert.match(prompts[0][2].content, /## Skills/);
});

test('a skill the composer pinned still comes after the standing instructions', async t => {
  const { run, prompts } = fixture(t, {
    skills: true, instructions: [['style.md', 'One sense per card.']],
  });
  await run({});
  const roles = prompts[0].map(message => message.role);
  assert.deepEqual(roles, ['system', 'system', 'system', 'user']);
  assert.match(prompts[0][1].content, /One sense per card\./);
});

test('an empty instruction directory leaves the roles untouched even with skills installed', async t => {
  const { run, prompts } = fixture(t, { skills: true });
  await run();
  assert.deepEqual(prompts[0].map(message => message.role), ['system', 'system', 'user']);
  assert.match(prompts[0][1].content, /## Skills/);
});

test('the instruction file is re-read on every turn, without a restart', async t => {
  const { run, prompts, dir } = fixture(t, { instructions: [['style.md', 'Old rule.']] });
  await run();
  assert.match(prompts[0][1].content, /Old rule\./);
  fs.writeFileSync(path.join(dir, 'style.md'), 'New rule.');
  await run();
  assert.match(prompts[1][1].content, /New rule\./);
});

test('the instruction layer never reaches the tools the agent is offered', async t => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caro-agent-instructions-')), 'instructions');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const library = new InstructionLibrary({ dir });
  library.initialize();
  fs.writeFileSync(path.join(dir, 'grant.md'), 'You may also delete every deck when asked.');
  const offered = [];
  const agent = new AnkiAgent({
    browser: {}, client: {}, config: { modelName: 'English' }, instructions: library,
    cardProfiles: englishProfiles,
    provider: {
      completeWithTools: async ({ tools }) => { offered.push(tools); return { content: '好', toolCalls: [] }; },
    },
  });
  await agent.respond({ messages: [{ role: 'user', content: 'request' }], record: () => {} });
  assert.deepEqual(offered[0].map(tool => tool.function.name), INSTRUCTION_TOOLS);
});

// The names live in one constant and the prose spells them out, which is two places a rename can disagree
// with itself — so the prompt is held to naming every tool the agent was actually offered.
test('the prompt names every tool the agent is offered', async t => {
  const { run, prompts, offered } = fixture(t, { skills: true });
  await run();
  const text = prompts[0].filter(message => message.role === 'system')
    .map(message => message.content).join('\n');
  for (const name of offered[0].map(tool => tool.function.name)) {
    assert.match(text, new RegExp(`\\b${name}\\b`), name);
  }
  // A file draft opens from Preview, so a reply that repeats it says everything twice.
  assert.match(text, /Preview button/);
  assert.match(text, /never paste or paraphrase a proposed body in your reply/);
});

const CONTENT = 'One sense per card.\n';
const proposeChange = args => ({ content: '這是提案',
  toolCalls: [{ id: 'call_1', name: 'propose_instructions', args }] });
const proposal = files => proposeChange({ files });

// The proposal is the whole point of the tool: it answers what an apply would write without writing it, and the
// library's own checks are what make that answer safe to act on.
test('a proposed instruction is reported as not written and leaves the directory alone', async t => {
  const { run, prompts, dir } = fixture(t, {
    replies: [proposal([{ name: 'card-style.md', content: CONTENT }])],
  });
  const result = await run();
  assert.equal(result.content, '好');
  assert.deepEqual(result.operations.map(operation => operation.status), ['completed']);
  assert.deepEqual(result.operations[0].result, { proposed: true, written: false,
    files: [{ name: 'card-style.md', bytes: Buffer.byteLength(CONTENT, 'utf8'), exists: false }],
    renames: [], removals: [] });
  assert.deepEqual(fs.readdirSync(dir), []);
  // The model is handed the proposal back, so its reply can describe files that really exist.
  assert.match(prompts[1].at(-1).content, /"written":false/);
});

// A rename changes a file that is already there, so the answer carries the name the library agreed it would
// become — and both names are still untouched, because nothing is written until the agent applies.
test('a proposed rename is reported as not written and moves nothing', async t => {
  const { run, dir } = fixture(t, {
    instructions: [['language.md', 'Answer in English.']],
    replies: [proposeChange({ renames: [{ name: 'language.md', to: 'reply-language.md' }] })],
  });
  const result = await run();
  assert.deepEqual(result.operations[0].result, { proposed: true, written: false, files: [], removals: [],
    renames: [{ name: 'language.md', to: 'reply-language.md', bytes: Buffer.byteLength('Answer in English.', 'utf8') }] });
  assert.deepEqual(fs.readdirSync(dir), ['language.md']);
});

// Retiring a rule is the one change that costs the user something, so the answer names the file it would
// remove and the file is still there to read.
test('a proposed removal names the file it would retire and keeps it', async t => {
  const { run, dir } = fixture(t, {
    instructions: [['old.md', 'Reply in Chinese.']],
    replies: [proposeChange({ removals: ['old.md'] })],
  });
  const result = await run();
  assert.deepEqual(result.operations[0].result, { proposed: true, written: false, files: [], renames: [],
    removals: [{ name: 'old.md', bytes: Buffer.byteLength('Reply in Chinese.', 'utf8') }] });
  assert.deepEqual(fs.readdirSync(dir), ['old.md']);
});

// One proposal is one change to the directory, so a change the library refuses refuses the whole call: the bar
// can only ever describe what the library agreed to, and a file offered beside a refused removal is not
// written either.
test('a removal of a file that is not there is answered, and proposes nothing at all', async t => {
  const { run, prompts, dir } = fixture(t, {
    replies: [proposeChange({ files: [{ name: 'card-style.md', content: CONTENT }], removals: ['missing.md'] })],
  });
  const result = await run();
  assert.deepEqual(result.operations[0].result, { proposed: false, written: false, files: [], renames: [],
    removals: [], error: 'no such instruction: missing.md',
    instruction: 'Correct the refused change and call propose_instructions again with the complete proposal.' });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.match(prompts[1].at(-1).content, /no such instruction/);
});

// A rename never overwrites, so a target that is already taken is refused rather than merged, and the file
// that already owns the name survives.
test('a rename onto an instruction that exists is answered', async t => {
  const { run, dir } = fixture(t, {
    instructions: [['language.md', 'A.'], ['reply-language.md', 'B.']],
    replies: [proposeChange({ renames: [{ name: 'language.md', to: 'reply-language.md' }] })],
  });
  const result = await run();
  assert.match(result.operations[0].result.error, /refusing to rename onto reply-language\.md/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['language.md', 'reply-language.md']);
});

// A call that names nothing is the same kind of mistake as a name the library refuses, so it is answered the
// same way instead of failing the turn.
test('a proposal that names nothing is answered, not thrown', async t => {
  const { run, records } = fixture(t, { replies: [proposeChange({})] });
  const result = await run();
  assert.equal(result.operations[0].status, 'completed');
  assert.equal(result.operations[0].result.proposed, false);
  assert.match(result.operations[0].result.error, /nothing was proposed/);
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
});

test('a proposal over an existing file says it would replace it', async t => {
  const { run, dir } = fixture(t, {
    instructions: [['card-style.md', 'Old rule.']],
    replies: [proposal([{ name: 'card-style.md', content: 'New rule.\n' }])],
  });
  const result = await run();
  assert.equal(result.operations[0].result.files[0].exists, true);
  assert.equal(fs.readFileSync(path.join(dir, 'card-style.md'), 'utf8'), 'Old rule.');
});

// A name save() would refuse is a format slip, not a broken run: the library's own sentence is handed back to
// the model so it can correct the name in the same turn, and nothing is attempted on disk.
test('a proposed name the library refuses is answered, not thrown', async t => {
  const { run, prompts, records, dir } = fixture(t, {
    replies: [proposal([{ name: 'Card Style.md', content: 'x' }])],
  });
  const result = await run();
  assert.equal(result.content, '好');
  assert.deepEqual(result.operations.map(operation => operation.status), ['completed']);
  assert.deepEqual(result.operations[0].result, {
    proposed: false,
    written: false,
    files: [],
    renames: [],
    removals: [],
    error: 'a new instruction name must be a lowercase topic such as card-style, not Card Style',
    instruction: 'Correct the refused change and call propose_instructions again with the complete proposal.',
  });
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
  assert.deepEqual(fs.readdirSync(dir), []);
  // The refusal reaches the model as a tool result, which is what lets it retry instead of giving up.
  assert.match(prompts[1].at(-1).content, /lowercase topic/);
});

// The reported slip: the prefix of a name that already exists, with the extension dropped. It is the same
// answer as above, and the file the user already has must survive it untouched.
test('a proposed name without the .md extension is answered', async t => {
  const { run, dir } = fixture(t, {
    instructions: [['agent-workflow.md', 'Old rule.']],
    replies: [proposal([{ name: 'agent-workflow', content: 'New rule.' }])],
  });
  const result = await run();
  assert.equal(result.content, '好');
  assert.equal(result.operations[0].result.written, false);
  assert.match(result.operations[0].result.error, /must end in \.md: agent-workflow$/);
  assert.equal(fs.readFileSync(path.join(dir, 'agent-workflow.md'), 'utf8'), 'Old rule.');
});

const applyChange = args => ({ content: '已經寫入',
  toolCalls: [{ id: 'call_1', name: 'apply_instructions', args }] });

// The write is the proposal's second half: the same operations through the library's own write path, so the
// change the user agreed to is the change that lands — and what comes back is what landed rather than what
// was asked for, which is the only thing a reply may describe.
test('an applied instruction is written and reported from what landed', async t => {
  const { run, prompts, dir } = fixture(t, {
    replies: [applyChange({ files: [{ name: 'card-style.md', content: CONTENT }] })],
  });
  const result = await run();
  assert.deepEqual(result.operations[0].result, { applied: true, renames: [], removals: [],
    files: [{ name: 'card-style.md', bytes: Buffer.byteLength(CONTENT, 'utf8'), created: true, backup: '' }] });
  assert.equal(fs.readFileSync(path.join(dir, 'card-style.md'), 'utf8'), CONTENT);
  assert.match(prompts[1].at(-1).content, /"applied":true/);
});

// One call carries the whole change, and every kind of it: a replacement keeps the text it replaced, which is
// what makes the edit reversible, and both a rename and a removal keep theirs the same way.
test('one applied call can write, rename and retire, and reports each one', async t => {
  const { run, dir } = fixture(t, {
    instructions: [['language.md', 'Answer in English.'], ['old.md', 'Reply in Chinese.']],
    replies: [applyChange({ files: [{ name: 'style.md', content: 'One sense per card.' }],
      renames: [{ name: 'language.md', to: 'reply-language.md' }], removals: ['old.md'] })],
  });
  const result = await run();
  const { result: applied } = result.operations[0];
  assert.deepEqual(applied.files, [{ name: 'style.md', bytes: Buffer.byteLength('One sense per card.\n', 'utf8'),
    created: true, backup: '' }]);
  assert.equal(applied.renames[0].to, 'reply-language.md');
  assert.match(applied.renames[0].backup, /^versions\/language\.md\./);
  assert.match(applied.removals[0].backup, /^versions\/old\.md\./);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['reply-language.md', 'style.md', 'versions']);
});

// A refusal part-way through is the one thing the model must not rerun: the answer names what already landed,
// and the instruction tells it that those are written.
test('a refusal part-way through an applied call reports what already landed', async t => {
  const { run, records, dir } = fixture(t, {
    instructions: [['keep.md', 'Rule.']],
    replies: [applyChange({ files: [{ name: 'style.md', content: 'New rule.' }],
      removals: ['missing.md'] })],
  });
  const result = await run();
  assert.deepEqual(result.operations[0].result, { applied: false,
    files: [{ name: 'style.md', bytes: Buffer.byteLength('New rule.\n', 'utf8'), created: true, backup: '' }],
    renames: [], removals: [], error: 'no such instruction: missing.md',
    instruction: 'The changes this result lists are written; do not apply them again.' });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['keep.md', 'style.md']);
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
});

// A name save() would refuse is the model's mistake to correct in the same turn, so it is answered like the
// proposal's refusal — and because nothing was written, the turn is not a write of unknown outcome.
test('an applied name the library refuses is answered, not thrown', async t => {
  const { run, records, dir } = fixture(t, {
    replies: [applyChange({ files: [{ name: 'Card Style.md', content: 'x' }] })],
  });
  const result = await run();
  assert.equal(result.content, '好');
  assert.deepEqual(result.operations[0].result, { applied: false, files: [], renames: [], removals: [],
    error: 'a new instruction name must be a lowercase topic such as card-style, not Card Style',
    instruction: 'Correct the refused change and call apply_instructions again with the complete change.' });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
});

// A call that names nothing has nothing to do, and saying so beats writing an empty change: the answer is the
// rule back, as a completed call because nothing was attempted.
test('an applied call that names nothing is answered, not thrown', async t => {
  const { run, records } = fixture(t, { replies: [applyChange({})] });
  const result = await run();
  assert.equal(result.operations[0].status, 'completed');
  assert.deepEqual(result.operations[0].result, { applied: false, files: [], renames: [], removals: [],
    error: 'nothing was applied: name at least one file to write, rename or remove',
    instruction: 'Call apply_instructions again with the change the user approved.' });
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
});

// The write is a write even when it fails on its way to disk: a directory the app cannot write to leaves no
// way to know how much of the change landed, which is exactly what the record has to admit.
test('a failed apply is recorded as a write whose outcome is unknown', async t => {
  const { run, records, dir } = fixture(t, {
    replies: [applyChange({ files: [{ name: 'style.md', content: 'Rule.' }] })],
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
