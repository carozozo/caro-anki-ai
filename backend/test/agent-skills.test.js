const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AnkiAgent } = require('../anki-agent');
const { SkillLibrary } = require('../skill-library');
const { englishProfiles } = require('./helpers/profile-fixture');

const BASE_TOOLS = ['search_notes', 'read_notes', 'list_tags', 'create_notes', 'update_notes', 'delete_notes', 'list_decks',
  'read_card_profiles', 'propose_card_profile', 'apply_card_profile'];
const AUDIT = ['card-audit', 'name: card-audit\ndescription: Audit notes against the card contract.',
  'Audit the target and report.'];
const REVIEW = ['instruction', 'name: instruction\ndescription: Author or revise a standing instruction.',
  'Read `references/review.md` before printing.', { 'review.md': '# Revision checklist' }];

let callId = 0;
const call = (name, args) => ({ content: name, toolCalls: [{ id: `call_${++callId}`, name, args }] });

// A real SkillLibrary over a temp directory, so the prompt, the tool list, and the tool's own answers are
// exercised against the code that runs in production rather than a stand-in. References are staged before
// `initialize()`, because the library scans `references/` once per load — a file written afterwards is on
// disk but not in the skill the prompt was built from.
const fixture = (t, { skills = [AUDIT], library = true, replies = [] } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caro-agent-skills-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, frontmatter, body, references = {}] of skills) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
    for (const [file, content] of Object.entries(references)) {
      fs.mkdirSync(path.join(dir, name, 'references'), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'references', file), `${content}\n`);
    }
  }
  const prompts = [];
  const offered = [];
  const records = [];
  const queue = [...replies];
  let skillsLibrary = null;
  if (library) {
    skillsLibrary = new SkillLibrary({ dir });
    skillsLibrary.initialize();
  }
  const agent = new AnkiAgent({
    browser: {}, client: {}, config: { modelName: 'English' }, skills: skillsLibrary,
    cardProfiles: englishProfiles,
    provider: {
      completeWithTools: async ({ messages, tools }) => {
        prompts.push(structuredClone(messages));
        offered.push(tools);
        return queue.shift() || { content: 'done', toolCalls: [] };
      },
      completeJson: async () => ({ effort: 'high' }),
    },
  });
  const run = (options = {}) => agent.respond({
    messages: [{ role: 'user', content: 'request' }],
    record: operation => records.push(structuredClone(operation)),
    ...options,
  });
  return { dir, run, prompts, offered, records, agent, library: skillsLibrary };
};

const toolNames = offered => offered.map(tool => tool.function.name);

test('without a library the agent offers no skill tool and adds no system message', async t => {
  const { run, prompts, offered } = fixture(t, { library: false });
  const result = await run();
  assert.deepEqual(toolNames(offered[0]), BASE_TOOLS);
  assert.deepEqual(prompts[0].map(message => message.role), ['system', 'user']);
  assert.deepEqual(result.skills, []);
});

// An empty library offers no catalogue but still offers the authoring pair: writing the first skill is
// exactly what it is for, and the model can only be told about a folder that does not exist yet.
test('an empty library contributes nothing to the prompt but offers the authoring tools', async t => {
  const { run, prompts, offered } = fixture(t, { skills: [] });
  const result = await run();
  assert.deepEqual(toolNames(offered[0]), [...BASE_TOOLS, 'propose_skills', 'apply_skills']);
  assert.deepEqual(prompts[0].map(message => message.role), ['system', 'user']);
  assert.deepEqual(result.skills, []);
});

test('a skill catalogue is injected as its own system message and offers the skill tool', async t => {
  const { run, prompts, offered } = fixture(t);
  const result = await run();
  assert.deepEqual(toolNames(offered[0]), [...BASE_TOOLS, 'propose_skills', 'apply_skills', 'load_skill']);
  assert.deepEqual(prompts[0].map(message => message.role), ['system', 'system', 'user']);
  assert.match(prompts[0][0].content, /You operate the user's Anki/);
  assert.match(prompts[0][1].content, /## Skills/);
  assert.match(prompts[0][1].content, /- card-audit: Audit notes against the card contract\./);
  assert.doesNotMatch(prompts[0][1].content, /Audit the target and report\./);
  assert.deepEqual(result.skills, []);
});

test('a model-disabled skill offers neither a catalogue line nor the tool', async t => {
  const { run, prompts, offered } = fixture(t, {
    skills: [['secret', 'name: secret\ndescription: Hidden.\ndisable-model-invocation: true', 'Hidden body.']],
  });
  await run();
  assert.deepEqual(toolNames(offered[0]), [...BASE_TOOLS, 'propose_skills', 'apply_skills']);
  assert.deepEqual(prompts[0].map(message => message.role), ['system', 'user']);
});

test('loading a skill returns its body, reports it, and feeds it back to the model', async t => {
  const { run, prompts, records } = fixture(t, { replies: [call('load_skill', { name: 'card-audit' })] });
  const result = await run();
  assert.equal(result.content, 'done');
  assert.deepEqual(result.skills, [{ name: 'card-audit', file: '' }]);
  assert.deepEqual(records.map(record => record.status), ['pending', 'completed']);
  assert.match(records[1].result.content, /Audit the target and report\./);
  const toolMessage = prompts[1].at(-1);
  assert.equal(toolMessage.role, 'tool');
  assert.match(toolMessage.content, /Audit the target and report\./);
});

test('a slash-prefixed and mixed-case name resolves to the real skill', async t => {
  const { run } = fixture(t, { replies: [call('load_skill', { name: '/Card-Audit' })] });
  const result = await run();
  assert.deepEqual(result.skills, [{ name: 'card-audit', file: '' }]);
});

test('a reference file is read on request and reported as the loaded skill', async t => {
  const { dir, run } = fixture(t, { replies: [call('load_skill', { name: 'card-audit', file: 'field-contract.md' })] });
  fs.mkdirSync(path.join(dir, 'card-audit/references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'card-audit/references/field-contract.md'), 'The field contract.\n');
  const result = await run();
  assert.deepEqual(result.skills, [{ name: 'card-audit', file: 'field-contract.md' }]);
  assert.equal(result.operations[0].result.content, 'The field contract.');
});

test('an unknown skill name answers the model with the real list instead of failing the turn', async t => {
  const { run, records } = fixture(t, { replies: [call('load_skill', { name: 'nope' })] });
  const result = await run();
  assert.equal(result.content, 'done');
  assert.deepEqual(result.skills, []);
  assert.deepEqual(records.map(record => record.status), ['pending', 'completed']);
  assert.equal(records[1].result.error, 'unknown skill: nope');
  assert.deepEqual(records[1].result.skills.map(skill => skill.name), ['card-audit']);
});

test('a listing call needs no name and reports no loaded skill', async t => {
  const { run } = fixture(t, { replies: [call('load_skill', {})] });
  const result = await run();
  assert.deepEqual(result.skills, []);
  assert.deepEqual(result.operations[0].result.skills.map(skill => skill.name), ['card-audit']);
});

// The composer pins a skill by starting the message with its command, so the backend reads the procedure
// straight off the request instead of hoping the model recognizes the name it was handed.
test('a message that commands a skill loads it before the first model call', async t => {
  const { run, prompts, records } = fixture(t);
  const result = await run({ messages: [{ role: 'user', content: '/card-audit check this card' }] });
  assert.deepEqual(prompts[0].map(message => message.role), ['system', 'system', 'system', 'user']);
  assert.match(prompts[0][2].content, /already loaded: follow it without reloading/);
  assert.match(prompts[0][2].content, /Audit the target and report\./);
  assert.equal(prompts[0].at(-1).content, '/card-audit check this card');
  assert.deepEqual(records.map(record => record.status), ['completed']);
  assert.deepEqual(records[0].action, { name: 'load_skill', args: { name: 'card-audit' } });
  assert.deepEqual(result.skills, [{ name: 'card-audit', file: '' }]);
  assert.deepEqual(result.operations.map(operation => operation.action.name), ['load_skill']);
  assert.equal(result.content, 'done');
});

test('a command nothing resolves, and prose that merely mentions one, preload nothing', async t => {
  for (const content of ['/missing check', 'use /card-audit on this', '/card']) {
    const { run, prompts, records } = fixture(t);
    const result = await run({ messages: [{ role: 'user', content }] });
    assert.deepEqual(prompts[0].map(message => message.role), ['system', 'system', 'user'], content);
    assert.deepEqual(records, [], content);
    assert.deepEqual(result.skills, [], content);
  }
});

test('a pinned skill is not loaded twice when the model calls the tool anyway', async t => {
  const { run, records } = fixture(t, { replies: [call('load_skill', { name: 'card-audit' })] });
  const result = await run({ messages: [{ role: 'user', content: '/card-audit check' }] });
  assert.deepEqual(result.skills, [{ name: 'card-audit', file: '' }]);
  assert.deepEqual(records.map(record => record.status), ['completed', 'pending', 'completed']);
});

// A pinned skill's body is not the whole skill: a body that names `references/<file>.md` is incomplete
// without it, and load_skill is the only way to read one. So the preload must leave that path open.
test('a pinned skill can still read its own reference file', async t => {
  const { run, prompts, offered, records } = fixture(t, {
    skills: [REVIEW],
    replies: [call('load_skill', { name: 'instruction', file: 'review.md' })],
  });
  const result = await run({ messages: [{ role: 'user', content: '/instruction change the reply language' }] });

  assert.deepEqual(toolNames(offered[0]), [...BASE_TOOLS, 'propose_skills', 'apply_skills', 'load_skill']);
  assert.deepEqual(prompts[0].map(message => message.role), ['system', 'system', 'system', 'user']);
  assert.match(prompts[0][2].content, /Read `references\/review\.md` before printing\./);
  assert.deepEqual(result.skills, [{ name: 'instruction', file: '' },
    { name: 'instruction', file: 'review.md' }]);
  assert.deepEqual(records.map(record => record.status), ['completed', 'pending', 'completed']);
  assert.equal(records[2].result.content, '# Revision checklist');
  assert.match(prompts[1].at(-1).content, /# Revision checklist/);
  assert.equal(result.content, 'done');
});

// The preload prompt is the only thing that can forbid the reference load, so it must name the exception:
// a pinned skill is not listed again, yet its `references/` files are still read on demand.
test('the pinned-skill prompt keeps the reference load open', async t => {
  const { run, prompts } = fixture(t, { skills: [REVIEW] });
  await run({ messages: [{ role: 'user', content: '/instruction change the reply language' }] });
  const command = prompts[0][2].content;
  assert.match(command, /already loaded: follow it without reloading/);
  assert.match(command, /references\/ file before acting/);
  assert.doesNotMatch(command, /reloading it/);
});

const SKILL_BODY = '---\nname: card-review\ndescription: Check one card.\n---\n\nRead the card.\n';
const proposal = (name, files) => ({ content: 'a proposal', toolCalls: [
  { id: 'call_1', name: 'propose_skills', args: { name, files } }] });
const proposeChange = args => ({ content: 'a proposal', toolCalls: [
  { id: 'call_1', name: 'propose_skills', args }] });

// A proposal is the whole point of the tool: it answers what a Save would do without doing it, and the
// library's own checks are what make that answer safe to press.
test('a proposed skill is reported as not written and leaves the directory alone', async t => {
  const { run, prompts, dir } = fixture(t, { replies: [proposal('card-review', [
    { path: 'SKILL.md', content: SKILL_BODY },
    { path: 'references/format.md', content: 'One rule per line.' }])] });
  const result = await run();
  assert.equal(result.content, 'done');
  assert.deepEqual(result.operations.map(operation => operation.status), ['completed']);
  assert.deepEqual(result.operations[0].result, { proposed: true, written: false, skill: 'card-review',
    created: true, files: [
      { path: 'SKILL.md', bytes: Buffer.byteLength(SKILL_BODY, 'utf8'), exists: false },
      { path: 'references/format.md', bytes: Buffer.byteLength('One rule per line.\n', 'utf8'), exists: false }],
    renames: [], removals: [] });
  assert.deepEqual(fs.readdirSync(dir), ['.caro-seeded', 'card-audit']);
  // The model is handed the proposal back, so its reply can describe a folder that really is about to exist.
  assert.match(prompts[1].at(-1).content, /"written":false/);
});

// The other two things a change can be: a rename and a removal are checked against the library without
// moving anything, so a target that is taken is refused before the user has agreed to it.
test('a proposed rename and removal are checked against the library and write nothing', async t => {
  const { run, dir } = fixture(t, { replies: [proposeChange(
    { renames: [{ name: 'card-audit', to: 'card-review' }], removals: ['card-audit'] })] });
  const result = await run();
  const bytes = fs.statSync(path.join(dir, 'card-audit', 'SKILL.md')).size;
  assert.deepEqual(result.operations[0].result, { proposed: true, written: false, files: [],
    renames: [{ name: 'card-audit', to: 'card-review', bytes }],
    removals: [{ name: 'card-audit', bytes }] });
  assert.deepEqual(fs.readdirSync(dir), ['.caro-seeded', 'card-audit']);
});

test('a proposed rename onto an installed skill is refused rather than shown', async t => {
  const { run } = fixture(t, { skills: [AUDIT, REVIEW],
    replies: [proposeChange({ renames: [{ name: 'card-audit', to: 'instruction' }] })] });
  const result = await run();
  assert.deepEqual(result.operations[0].result, {
    proposed: false,
    written: false,
    files: [],
    renames: [],
    removals: [],
    error: 'refusing to rename onto instruction: that skill already exists',
    instruction: 'Correct the refused change and call propose_skills again with the complete folder.',
  });
});

test('a proposal over an installed skill says it would replace it', async t => {
  const { run, dir } = fixture(t, { replies: [proposal('card-audit', [{ path: 'SKILL.md',
    content: '---\nname: card-audit\ndescription: Revised.\n---\n\nRevised body.\n' }])] });
  const result = await run();
  assert.equal(result.operations[0].result.created, false);
  assert.equal(result.operations[0].result.files[0].exists, true);
  assert.match(fs.readFileSync(path.join(dir, 'card-audit', 'SKILL.md'), 'utf8'), /Audit the target/);
});

// A folder save() would refuse is a format slip, not a broken run: the library's own sentence goes back to
// the model so it can correct it in the same turn, and nothing is attempted on disk.
test('a proposed skill the library refuses is answered, not thrown', async t => {
  const { run, prompts, records, dir } = fixture(t, { replies: [proposal('card-review', [
    { path: 'SKILL.md', content: '---\nname: card-audit\ndescription: x.\n---\n\nBody.\n' }])] });
  const result = await run();
  assert.equal(result.content, 'done');
  assert.deepEqual(result.operations[0].result, {
    proposed: false,
    written: false,
    files: [],
    renames: [],
    removals: [],
    error: 'frontmatter name "card-audit" does not match folder "card-review"',
    instruction: 'Correct the refused change and call propose_skills again with the complete folder.',
  });
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
  assert.deepEqual(fs.readdirSync(dir), ['.caro-seeded', 'card-audit']);
  // The refusal reaches the model as a tool result, which is what lets it retry instead of giving up.
  assert.match(prompts[1].at(-1).content, /does not match folder/);
});

const applySkill = (name, files) => ({ content: 'written', toolCalls: [
  { id: 'call_1', name: 'apply_skills', args: { name, files } }] });
const applyChange = args => ({ content: 'written', toolCalls: [
  { id: 'call_1', name: 'apply_skills', args }] });

// The write is the proposal's second half, and a folder lands whole in one call: the body and the reference it
// names arrive together, so the library never holds a body that names a file it does not have.
test('an applied skill folder is written whole and reported per file', async t => {
  const { run, prompts, dir } = fixture(t, { replies: [applySkill('card-review', [
    { path: 'SKILL.md', content: SKILL_BODY },
    { path: 'references/format.md', content: 'One rule per line.' }])] });
  const result = await run();
  assert.deepEqual(result.operations.map(operation => operation.status), ['completed']);
  assert.deepEqual(result.operations[0].result, { applied: true, skill: 'card-review', created: true, files: [
    { path: 'SKILL.md', bytes: Buffer.byteLength(SKILL_BODY, 'utf8'), created: true, backup: '' },
    { path: 'references/format.md', bytes: Buffer.byteLength('One rule per line.\n', 'utf8'),
      created: true, backup: '' }], renames: [], removals: [] });
  assert.equal(fs.readFileSync(path.join(dir, 'card-review', 'SKILL.md'), 'utf8'), SKILL_BODY);
  assert.equal(fs.readFileSync(path.join(dir, 'card-review', 'references', 'format.md'), 'utf8'),
    'One rule per line.\n');
  // The model is handed what landed, so its reply can describe a folder that is really installed.
  assert.match(prompts[1].at(-1).content, /"applied":true/);
});

// A rename and a removal are writes of their own, and both keep the text they displace under versions/, which
// is what makes the two of them as reversible as a replacement.
test('an applied rename keeps the instructions and an applied removal retires the folder', async t => {
  const { run, dir } = fixture(t, { skills: [AUDIT, REVIEW], replies: [applyChange({
    renames: [{ name: 'instruction', to: 'trusted-instruction' }], removals: ['card-audit'] })] });
  const result = await run();
  const applied = result.operations[0].result;
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.renames, [{ name: 'instruction', to: 'trusted-instruction',
    backup: 'versions/instruction' }]);
  assert.deepEqual(applied.removals, [{ name: 'card-audit', backup: 'versions/card-audit' }]);
  // A rename is not a rewrite: the body keeps its text and only the line that names the folder follows it.
  assert.match(fs.readFileSync(path.join(dir, 'trusted-instruction', 'SKILL.md'), 'utf8'),
    /^---\nname: trusted-instruction\ndescription: Author or revise a standing instruction\./);
  assert.equal(fs.readFileSync(path.join(dir, 'trusted-instruction', 'references', 'review.md'), 'utf8'),
    '# Revision checklist\n');
  assert.equal(fs.existsSync(path.join(dir, 'card-audit')), false);
  // The retired folder is kept whole under the name it had, so the removal is recoverable.
  assert.equal(fs.readdirSync(path.join(dir, 'versions', 'card-audit'))
    .filter(entry => entry.startsWith('SKILL.md.')).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'versions')).sort(), ['card-audit', 'instruction']);
});

// One call can carry several operations, so a refusal that follows a write has to report what already landed:
// telling the model to try the pair again would have it rename a folder that is already gone.
test('a refusal after a rename reports what already landed', async t => {
  const { run, records, dir } = fixture(t, { replies: [applyChange({
    renames: [{ name: 'card-audit', to: 'card-review' }], removals: ['missing'] })] });
  const result = await run();
  const applied = result.operations[0].result;
  assert.equal(applied.applied, false);
  assert.deepEqual(applied.renames.map(({ name, to }) => [name, to]), [['card-audit', 'card-review']]);
  assert.match(applied.error, /unknown skill: missing/);
  assert.equal(applied.instruction, 'The changes this result lists are written; do not apply them again.');
  assert.equal(fs.existsSync(path.join(dir, 'card-review')), true);
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
});

// Replacing an installed skill keeps the file it replaced under versions/, which is what makes the edit
// reversible — and a file the call omits is left exactly as the user wrote it.
test('an applied revision keeps the replaced file and leaves an untouched reference alone', async t => {
  const { run, dir } = fixture(t, { skills: [REVIEW], replies: [applySkill('instruction', [
    { path: 'SKILL.md', content: '---\nname: instruction\ndescription: Revised.\n---\n\nRevised body.\n' }])] });
  const result = await run();
  const { result: applied } = result.operations[0];
  assert.equal(applied.created, false);
  assert.deepEqual(applied.files.map(({ path: file, created, backup }) => [file, created, Boolean(backup)]),
    [['SKILL.md', false, true]]);
  assert.match(applied.files[0].backup, /^versions\/instruction\/SKILL\.md\./);
  assert.match(fs.readFileSync(path.join(dir, 'instruction', 'SKILL.md'), 'utf8'), /Revised body/);
  assert.equal(fs.readFileSync(path.join(dir, 'instruction', 'references', 'review.md'), 'utf8'),
    '# Revision checklist\n');
});

// A folder save() would refuse is the model's mistake to correct in the same turn, so it is answered — and a
// refusal lands no file at all, which is why the turn is not a write of unknown outcome.
test('an applied skill the library refuses is answered, not thrown', async t => {
  const { run, records, dir } = fixture(t, { replies: [applySkill('card-review', [
    { path: 'SKILL.md', content: '---\nname: card-audit\ndescription: x.\n---\n\nBody.\n' }])] });
  const result = await run();
  assert.deepEqual(result.operations[0].result, { applied: false, files: [], renames: [], removals: [],
    error: 'frontmatter name "card-audit" does not match folder "card-review"',
    instruction: 'Correct the refused change and call apply_skills again with the complete folder.' });
  assert.deepEqual(fs.readdirSync(dir), ['.caro-seeded', 'card-audit']);
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
});

// A call that names no file cannot have written one, so it is a correction rather than a write of unknown
// outcome: the answer is the rule back, as a completed call.
test('an applied folder that carries no file is answered, not thrown', async t => {
  const { run, records } = fixture(t, { replies: [applySkill('card-review', [])] });
  const result = await run();
  assert.equal(result.operations[0].status, 'completed');
  assert.deepEqual(result.operations[0].result, { applied: false, files: [], renames: [], removals: [],
    error: 'nothing was applied: a skill folder carries at least its SKILL.md',
    instruction: 'Call apply_skills again with the change the user approved.' });
  assert.equal(records.every(entry => entry.outcomeUnknown !== true), true);
});

// The pair is the whole authoring surface: one tool shows the folder, its renames and its removals, the other
// writes the change the user agreed to, and nothing else reaches the library from a turn.
test('the skill tooling offers a proposal, its apply, and nothing else', async t => {
  const { run, prompts, offered } = fixture(t);
  await run();
  const authored = toolNames(offered[0]).filter(name => name !== 'load_skill' && !BASE_TOOLS.includes(name));
  assert.deepEqual(authored, ['propose_skills', 'apply_skills']);
  const text = prompts[0].filter(message => message.role === 'system')
    .map(message => message.content).join('\n');
  assert.match(text, /propose_skills previews without writing/);
  assert.match(text, /creates Preview/);
  assert.match(text, /Never call a proposed change saved or paste its body in your reply/);
  assert.match(text, /report only apply_skills results/);
  assert.match(text, /Use a rename for a name-only change/);
  assert.match(text, /a merge is a write plus removal/);
});
