const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectRoot } = require('../config');
const { SKILL_BODY_LIMIT, SkillLibrary, commandName, parseSkillMarkdown, referenceRelPath, skillToken } =
  require('../skill-library');

const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caro-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir: path.join(root, 'skills'), seedDir: path.join(root, 'seed') };
};

const writeSkill = (dir, name, frontmatter, body = 'Body.') => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
};

// The library keeps its own dotfiles beside the skills, so a fixture listing is the folders a user would see.
const folders = dir => fs.readdirSync(dir).filter(entry => !entry.startsWith('.')).sort();

test('parses frontmatter values that contain quotes and colons', () => {
  const { meta, body } = parseSkillMarkdown('---\nname: alpha\ndescription: "Use when: auditing"\n---\n\n# Alpha\n');
  assert.equal(meta.name, 'alpha');
  assert.equal(meta.description, 'Use when: auditing');
  assert.equal(body, '# Alpha');
  assert.equal(parseSkillMarkdown('---\nname: alpha\n---\n').body, '');
});

test('reports a document with no frontmatter block as unparsed', () => {
  assert.deepEqual(parseSkillMarkdown('# Alpha\n'), { meta: null, body: '# Alpha' });
});

test('normalises slash tokens and rejects names that could not be a folder', () => {
  assert.equal(skillToken('/Card-Audit'), 'card-audit');
  assert.equal(skillToken('  card-audit  '), 'card-audit');
  for (const value of ['card_audit', 'card--audit', '-audit', 'audit-', 'a'.repeat(65), '', null]) {
    assert.equal(skillToken(value), '', String(value));
  }
});

test('reads a command only from the first word of a message', () => {
  assert.equal(commandName('/card-audit'), 'card-audit');
  assert.equal(commandName('/Card-Audit check all cards'), 'card-audit');
  assert.equal(commandName('  /card-audit\ncheck'), 'card-audit');
  assert.equal(commandName('/card--audit'), '');
  assert.equal(commandName('check /card-audit'), '');
  assert.equal(commandName('card-audit'), '');
  assert.equal(commandName('/'), '');
  assert.equal(commandName(null), '');
});

test('pins the skill a message commands, and reads anything else as prose', async t => {
  const { dir } = fixture(t);
  writeSkill(dir, 'alpha', 'name: alpha\ndescription: Does alpha.');
  writeSkill(dir, 'model-only', 'name: model-only\ndescription: Hidden.\nuser-invocable: false');
  const library = new SkillLibrary({ dir });
  library.initialize();
  assert.equal(library.pinned('/alpha check').name, 'alpha');
  assert.equal(library.pinned('/ALPHA'), library.skills.get('alpha'));
  assert.equal(library.pinned('/model-only'), null);
  for (const value of ['/missing', '/alpha_extra', '/alpha-extra', 'use /alpha', 'alpha', '', null]) {
    assert.equal(library.pinned(value), null, String(value));
  }
});

test('accepts only a flat markdown or text reference name', () => {
  assert.equal(referenceRelPath('field-contract.md'), 'field-contract.md');
  assert.equal(referenceRelPath(' notes.txt '), 'notes.txt');
  for (const value of ['../secret.md', 'nested/notes.md', 'C:\\notes.md', '/etc/passwd.md', 'notes.json',
    'notes', '']) {
    assert.equal(referenceRelPath(value), '', value);
  }
});

test('catalogues valid skills and ignores everything that is not one', async t => {
  const { dir } = fixture(t);
  writeSkill(dir, 'beta', 'name: beta\ndescription: Does beta.');
  writeSkill(dir, 'alpha', 'name: alpha\ndescription: Does alpha.');
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Skills\n');

  const library = new SkillLibrary({ dir });
  assert.deepEqual(library.initialize().map(skill => skill.name), ['alpha', 'beta']);
  assert.deepEqual(library.errors(), []);
  assert.deepEqual(library.names(), ['alpha', 'beta']);
});

test('records an invalid skill instead of throwing, and keeps the valid ones', async t => {
  const { dir } = fixture(t);
  writeSkill(dir, 'alpha', 'name: alpha\ndescription: Does alpha.');
  writeSkill(dir, 'Long', 'name: Long\ndescription: Uppercase folder.');
  writeSkill(dir, 'mismatch', 'name: other\ndescription: Names another folder.');
  writeSkill(dir, 'no-desc', 'name: no-desc');
  writeSkill(dir, 'too-long', `name: too-long\ndescription: ${'d'.repeat(1025)}`);
  fs.mkdirSync(path.join(dir, 'no-front'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'no-front', 'SKILL.md'), 'Just a body.\n');

  const library = new SkillLibrary({ dir });
  assert.deepEqual(library.initialize().map(skill => skill.name), ['alpha']);
  const errors = Object.fromEntries(library.errors().map(item => [item.name, item.error]));
  assert.deepEqual(Object.keys(errors).sort(), ['Long', 'mismatch', 'no-desc', 'no-front', 'too-long']);
  assert.match(errors.Long, /invalid skill folder name/);
  assert.match(errors.mismatch, /does not match folder/);
  assert.match(errors['no-desc'], /missing frontmatter description/);
  assert.match(errors['no-front'], /missing frontmatter block/);
  assert.match(errors['too-long'], /exceeds 1024 characters/);
});

test('loads a skill body, one reference at a time', async t => {
  const { dir } = fixture(t);
  writeSkill(dir, 'alpha', 'name: alpha\ndescription: Does alpha.', '## Workflow\n\n1. Step.');
  const references = path.join(dir, 'alpha', 'references');
  fs.mkdirSync(references, { recursive: true });
  fs.writeFileSync(path.join(references, 'detail.md'), '# Detail\n');
  fs.writeFileSync(path.join(references, 'notes.json'), '{}');

  const library = new SkillLibrary({ dir });
  library.initialize();
  const skill = library.resolve('/alpha');
  assert.equal(skill.body, '## Workflow\n\n1. Step.');
  assert.deepEqual(skill.references, ['detail.md']);
  assert.equal(library.list()[0].body, undefined);
  assert.equal(library.body('alpha'), '## Workflow\n\n1. Step.');
  assert.equal(library.body('alpha', { file: 'detail.md' }), '# Detail');
});

test('rejects unknown skills and references that leave the skill directory', async t => {
  const { root, dir } = fixture(t);
  writeSkill(dir, 'alpha', 'name: alpha\ndescription: Does alpha.');
  const references = path.join(dir, 'alpha', 'references');
  fs.mkdirSync(references, { recursive: true });
  const outside = path.join(root, 'outside.md');
  fs.writeFileSync(outside, '# Outside\n');
  fs.symlinkSync(outside, path.join(references, 'leak.md'));

  const library = new SkillLibrary({ dir });
  library.initialize();
  assert.throws(() => library.resolve('missing'), { statusCode: 404 });
  assert.throws(() => library.resolve('card_audit'), { statusCode: 404 });
  assert.throws(() => library.body('alpha', { file: '../README.md' }), /invalid skill reference/);
  assert.throws(() => library.body('alpha', { file: 'nested/detail.md' }), /invalid skill reference/);
  assert.throws(() => library.body('alpha', { file: 'missing.md' }), { statusCode: 404 });
  // A symlink is not listed as a reference at all, and reading one by name still refuses to leave the skill.
  assert.deepEqual(library.resolve('alpha').references, []);
  assert.throws(() => library.body('alpha', { file: 'leak.md' }), /escapes its skill directory/);
});

test('truncates an oversized body for the model', async t => {
  const { dir } = fixture(t);
  writeSkill(dir, 'alpha', 'name: alpha\ndescription: Does alpha.', 'x'.repeat(SKILL_BODY_LIMIT + 500));
  const library = new SkillLibrary({ dir });
  library.initialize();
  const skillBody = library.body('alpha');
  assert.ok(skillBody.length < SKILL_BODY_LIMIT + 50, `length ${skillBody.length}`);
  assert.match(skillBody, /…\(truncated\)$/);
  assert.ok(library.resolve('alpha').body.length > SKILL_BODY_LIMIT);
});

test('catalogues only the skills the model may invoke', async t => {
  const { dir } = fixture(t);
  fs.mkdirSync(dir, { recursive: true });
  const empty = new SkillLibrary({ dir });
  empty.initialize();
  assert.equal(empty.catalogue(), '');

  writeSkill(dir, 'alpha', 'name: alpha\ndescription: Does alpha.');
  writeSkill(dir, 'beta', `name: beta\ndescription: ${'d'.repeat(400)}`);
  writeSkill(dir, 'manual',
    'name: manual\ndescription: Runs only when invoked.\nuser-invocable: false');
  writeSkill(dir, 'hidden',
    'name: hidden\ndescription: Never automatic.\ndisable-model-invocation: true');

  const library = new SkillLibrary({ dir });
  library.initialize();
  const catalogue = library.catalogue();
  assert.match(catalogue, /^- alpha: Does alpha\.$/m);
  assert.match(catalogue, /^- beta: d{250} …$/m);
  assert.match(catalogue, /^- manual: Runs only when invoked\.$/m);
  assert.equal(catalogue.includes('hidden'), false);
  assert.equal(library.resolve('hidden').disableModelInvocation, true);
  assert.equal(library.resolve('manual').userInvocable, false);
  assert.equal(library.resolve('alpha').userInvocable, true);
  assert.equal(library.catalogue({ maxDescription: 5 }).includes('- beta: ddddd …'), true);
  assert.equal(catalogue.includes('d'.repeat(251)), false);
  assert.equal(catalogue.includes('d'.repeat(250)), true);
});

test('copies the bundled seeds once and never overwrites an edit', async t => {
  const { dir, seedDir } = fixture(t);
  writeSkill(seedDir, 'alpha', 'name: alpha\ndescription: Seeded alpha.', 'Seeded body.');

  const library = new SkillLibrary({ dir, seedDir });
  assert.equal(library.seed(), true);
  assert.equal(library.seed(), false);
  assert.deepEqual(library.refresh().map(skill => skill.name), ['alpha']);
  assert.equal(library.entries()[0].seeded, true);
  assert.equal(library.body('alpha'), 'Seeded body.');

  fs.writeFileSync(path.join(dir, 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: Edited by hand.\n---\n\nEdited body.\n');
  writeSkill(seedDir, 'alpha', 'name: alpha\ndescription: Rewritten seed.', 'Rewritten.');

  const reopened = new SkillLibrary({ dir, seedDir });
  assert.equal(reopened.initialize()[0].description, 'Edited by hand.');
  const edited = new SkillLibrary({ dir, seedDir });
  edited.refresh();
  assert.equal(edited.body('alpha'), 'Edited body.');
});

test('initialises a library with no seed directory at all', async t => {
  const { dir, seedDir } = fixture(t);
  const library = new SkillLibrary({ dir, seedDir });
  assert.deepEqual(library.initialize(), []);
  assert.equal(fs.existsSync(path.join(dir, '.caro-seeded')), true);
});

// A proposal has to answer what a save would do without doing it, because that answer is what the chat turns
// into a Save button: the folder, whether it is new, and each file it would land.
test('checks a proposed skill folder without touching the disk', async t => {
  const { dir, seedDir } = fixture(t);
  const library = new SkillLibrary({ dir, seedDir });
  library.initialize();

  const body = '---\nname: alpha\ndescription: Audit one card.\n---\n\nRead the card.\n';
  const check = library.check('alpha', [{ path: 'SKILL.md', content: body },
    { path: 'references/format.md', content: 'One rule per line.' }]);
  assert.deepEqual(check, { name: 'alpha', created: true, files: [
    { path: 'SKILL.md', bytes: Buffer.byteLength(body), exists: false },
    { path: 'references/format.md', bytes: Buffer.byteLength('One rule per line.\n'), exists: false },
  ] });
  assert.equal(fs.existsSync(path.join(dir, 'alpha')), false);

  // The same check against a skill already on disk is what arms the button instead of saving on one click.
  library.save('alpha', [{ path: 'SKILL.md', content: body }]);
  assert.deepEqual(library.check('alpha', [{ path: 'SKILL.md', content: body }]), {
    name: 'alpha', created: false,
    files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(body), exists: true }],
  });
});

// Everything a save cannot load is refused at proposal time, when the model can still fix it: a body that
// does not load would be a folder the catalogue silently drops, and a path the loader never reads is a file
// the user wrote for nothing.
test('refuses a skill the loader could not read back', async t => {
  const { dir, seedDir } = fixture(t);
  const library = new SkillLibrary({ dir, seedDir });
  library.initialize();
  const frontmatter = meta => `---\n${meta}\n---\n\nProcedure.\n`;
  const refuses = (name, files, pattern) => assert.throws(() => library.check(name, files), pattern);

  refuses('alpha skill', [{ path: 'SKILL.md', content: frontmatter('name: alpha\ndescription: x.') }],
    /lowercase name/);
  refuses('alpha', [{ path: 'SKILL.md', content: frontmatter('name: Beta\ndescription: x.') }],
    /invalid frontmatter name/);
  refuses('alpha', [{ path: 'SKILL.md', content: frontmatter('name: beta\ndescription: x.') }],
    /does not match folder/);
  refuses('alpha', [{ path: 'SKILL.md', content: frontmatter('name: alpha') }], /missing frontmatter description/);
  refuses('alpha', [{ path: 'SKILL.md', content: frontmatter('name: alpha\ndescription: x.') },
    { path: 'notes.md', content: 'x' }], /invalid skill file: notes.md/);
  refuses('alpha', [{ path: 'references/deep/nested.md', content: 'x' },
    { path: 'SKILL.md', content: frontmatter('name: alpha\ndescription: x.') }], /invalid skill file/);
  refuses('alpha', [{ path: 'SKILL.md', content: frontmatter('name: alpha\ndescription: x.') },
    { path: 'references/format.md', content: '   ' }], /is empty/);
  refuses('alpha', [{ path: 'SKILL.md', content: 'x'.repeat(SKILL_BODY_LIMIT + 1) }], /silently truncate/);
  // One path named twice would leave whichever copy landed last, which is not a save anyone can predict.
  const twice = frontmatter('name: alpha\ndescription: x.');
  refuses('alpha', [{ path: 'SKILL.md', content: twice }, { path: 'SKILL.md', content: twice }],
    /exactly once/);
  refuses('alpha', [{ path: 'references/format.md', content: 'x' }], /SKILL.md is required/);
  refuses('alpha', [], /at least one file/);

  assert.equal(fs.existsSync(path.join(dir, 'alpha')), false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.caro-seeded']);
});

test('accepts a skill with only valid frontmatter as an editable blank draft', async t => {
  const { dir, seedDir } = fixture(t);
  const library = new SkillLibrary({ dir, seedDir });
  library.initialize();
  const content = '---\nname: alpha\ndescription: Blank draft.\n---\n';

  library.save('alpha', [{ path: 'SKILL.md', content }]);
  assert.deepEqual(library.entries(), [{ name: 'alpha', description: 'Blank draft.', body: '' }]);
  assert.equal(library.body('alpha'), '');
});

// The read half of a save for a folder: the same name and body rules, and for each file whether the write
// would replace something the user already has. A proposal is validated by it, so a save can never refuse what
// a check accepted — and nothing is touched, because a check is not a save.
test('the read half of a skill save answers what it would create without writing', async t => {
  const { dir, seedDir } = fixture(t);
  const library = new SkillLibrary({ dir, seedDir });
  library.initialize();
  const body = '---\nname: alpha\ndescription: Audit one card.\n---\n\nRead the card.\n';
  const rule = 'One rule per line.\n';
  const files = [{ path: 'SKILL.md', content: body }, { path: 'references/format.md', content: rule }];
  const plan = (created, exists) => ({ name: 'alpha', created, files: [
    { path: 'SKILL.md', bytes: Buffer.byteLength(body, 'utf8'), exists },
    { path: 'references/format.md', bytes: Buffer.byteLength(rule, 'utf8'), exists },
  ] });

  assert.deepEqual(library.check('alpha', files), plan(true, false));
  assert.equal(fs.existsSync(path.join(dir, 'alpha')), false);

  library.save('alpha', files);
  assert.deepEqual(library.check('alpha', files), plan(false, true));
  // A reference the proposal leaves out is not part of the question: the folder still holds what was proposed.
  assert.deepEqual(library.check('alpha', [files[0]]).files, [plan(false, true).files[0]]);

  // Reading a check never writes, and it refuses the same names a save would — a folder the loader would skip
  // is one the model could never be told about, so a new skill name is held to the lower-case form either way.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'alpha')).sort(), ['SKILL.md', 'references']);
  assert.throws(() => library.check('alpha skill', files), /lowercase name/);
});

test('saves a whole skill folder, keeping the text it replaced', async t => {
  const { dir, seedDir } = fixture(t);
  const library = new SkillLibrary({ dir, seedDir });
  library.initialize();

  const first = '---\nname: alpha\ndescription: First.\n---\n\nFirst body.\n';
  const saved = library.save('alpha', [{ path: 'SKILL.md', content: first },
    { path: 'references/format.md', content: 'One rule per line.' }]);
  assert.equal(saved.name, 'alpha');
  assert.equal(saved.created, true);
  assert.deepEqual(saved.files.map(file => [file.path, file.created, Boolean(file.backup)]),
    [['SKILL.md', true, false], ['references/format.md', true, false]]);
  // A folder a save accepts is one the catalogue lists on the next read, without a restart.
  assert.deepEqual(library.list().map(skill => [skill.name, skill.references]),
    [['alpha', ['format.md']]]);
  assert.equal(library.body('alpha'), 'First body.');
  assert.equal(fs.readFileSync(path.join(dir, 'alpha', 'references', 'format.md'), 'utf8'),
    'One rule per line.\n');

  // Replacing the body keeps the previous text, and a reference the new proposal never named is left alone.
  const second = '---\nname: alpha\ndescription: Second.\n---\n\nSecond body.\n';
  const again = library.save('alpha', [{ path: 'SKILL.md', content: second }]);
  assert.equal(again.created, false);
  assert.match(again.files[0].backup, /^versions\/alpha\/SKILL\.md\./);
  assert.equal(fs.readFileSync(path.join(dir, again.files[0].backup), 'utf8'), first);
  assert.equal(library.body('alpha'), 'Second body.');
  assert.deepEqual(library.list()[0].references, ['format.md']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'alpha')).sort(), ['SKILL.md', 'references']);

  // A reference is versioned beside itself, so one replaced by a revised folder keeps its own copy under its
  // own name. Every save restates the body, because a folder without one is not a skill: the proposal is
  // always a whole folder, whatever subset of its references it moves.
  library.save('alpha', [{ path: 'SKILL.md', content: second },
    { path: 'references/format.md', content: 'Two rules per line.' }]);
  const kept = fs.readdirSync(path.join(dir, 'versions', 'alpha', 'references'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'versions', 'alpha', 'references', kept[0]), 'utf8'),
    'One rule per line.\n');
  assert.equal(fs.readFileSync(path.join(dir, 'alpha', 'references', 'format.md'), 'utf8'),
    'Two rules per line.\n');
});

// A folder where a skill belongs is not a skill, so it is refused rather than written into: the model gets a
// sentence it can act on, and whatever the user has there is left exactly as it was.
test('refuses to save a skill over something that is not a folder', async t => {
  const { dir, seedDir } = fixture(t);
  const library = new SkillLibrary({ dir, seedDir });
  library.initialize();
  fs.writeFileSync(path.join(dir, 'alpha'), 'not a folder');

  assert.throws(() => library.check('alpha', [{ path: 'SKILL.md', content: 'x' }]), /is not a directory/);
  assert.throws(() => library.save('alpha', [{ path: 'SKILL.md', content: 'x' }]), /is not a directory/);
  assert.equal(fs.readFileSync(path.join(dir, 'alpha'), 'utf8'), 'not a folder');
});

// A rename is a folder move plus the one frontmatter line that has to follow it, and the target has to be
// free: the operation that tidies a name must never be the one that destroys a folder.
test('renames a skill folder, taking its frontmatter name and its references with it', async t => {
  const { dir } = fixture(t);
  writeSkill(dir, 'alpha', 'name: alpha\ndescription: Does alpha.', 'Alpha body.');
  fs.mkdirSync(path.join(dir, 'alpha', 'references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'alpha', 'references', 'detail.md'), '# Detail\n');
  writeSkill(dir, 'beta', 'name: beta\ndescription: Does beta.');
  const library = new SkillLibrary({ dir });
  library.initialize();
  const original = fs.readFileSync(path.join(dir, 'alpha', 'SKILL.md'), 'utf8');
  const bytes = original.length + Buffer.byteLength('# Detail\n', 'utf8');

  assert.deepEqual(library.checkRename('alpha', 'gamma'), { name: 'alpha', to: 'gamma', bytes });
  assert.throws(() => library.checkRename('alpha', 'beta'), /already exists/);
  assert.throws(() => library.checkRename('alpha', 'alpha'), /already its own name/);
  assert.throws(() => library.checkRename('missing', 'gamma'), /unknown skill: missing/);
  assert.throws(() => library.checkRename('alpha', 'Bad Name'), /must be a lowercase name/);
  assert.deepEqual(folders(dir), ['alpha', 'beta']);

  const renamed = library.rename('/Alpha', 'gamma');
  assert.equal(renamed.name, 'alpha');
  assert.equal(renamed.to, 'gamma');
  assert.equal(renamed.backup, 'versions/alpha');
  assert.deepEqual(library.names(), ['beta', 'gamma']);
  // The frontmatter follows the folder — the one line that may change — and the body is the user's, untouched.
  assert.equal(fs.readFileSync(path.join(dir, 'gamma', 'SKILL.md'), 'utf8'),
    original.replace('name: alpha', 'name: gamma'));
  assert.equal(fs.readFileSync(path.join(dir, 'gamma', 'references', 'detail.md'), 'utf8'), '# Detail\n');
  assert.equal(library.body('gamma'), 'Alpha body.');
  // The folder left behind is kept whole, references included, where the loader never reads it.
  const kept = fs.readdirSync(path.join(dir, 'versions', 'alpha', 'references'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'versions', 'alpha', 'references', kept[0]), 'utf8'), '# Detail\n');
});

// Retiring a skill is its own operation rather than an empty folder save, and it leaves no menu entry behind.
test('retires a skill folder and keeps every file it held', async t => {
  const { dir } = fixture(t);
  writeSkill(dir, 'alpha', 'name: alpha\ndescription: Does alpha.', 'Alpha body.');
  fs.mkdirSync(path.join(dir, 'alpha', 'references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'alpha', 'references', 'detail.md'), '# Detail\n');
  const library = new SkillLibrary({ dir });
  library.initialize();
  const original = fs.readFileSync(path.join(dir, 'alpha', 'SKILL.md'), 'utf8');
  const bytes = original.length + Buffer.byteLength('# Detail\n', 'utf8');

  assert.deepEqual(library.checkRemove('/Alpha'), { name: 'alpha', bytes });
  assert.throws(() => library.checkRemove('missing'), /unknown skill: missing/);
  assert.deepEqual(folders(dir), ['alpha']);

  assert.deepEqual(library.remove('alpha'), { name: 'alpha', backup: 'versions/alpha' });
  assert.deepEqual(library.names(), []);
  assert.equal(fs.existsSync(path.join(dir, 'alpha')), false);
  const copies = fs.readdirSync(path.join(dir, 'versions', 'alpha'));
  const body = copies.find(entry => entry.startsWith('SKILL.md.'));
  assert.equal(fs.readFileSync(path.join(dir, 'versions', 'alpha', body), 'utf8'), original);
});

test('ships seeds that load against the published specification', () => {
  const library = new SkillLibrary({ dir: path.join(projectRoot, 'skills') });
  library.refresh();
  assert.deepEqual(library.errors(), []);
  assert.deepEqual(library.names(), ['instruction', 'skill']);
  assert.equal(library.body('instruction', { file: 'format.md' })
    .startsWith('# Instruction file format'), true);
  assert.equal(library.body('instruction', { file: 'review.md' })
    .startsWith('# Revision checklist'), true);
  assert.equal(library.body('skill', { file: 'format.md' }).startsWith('# Skill format'), true);
  assert.equal(library.body('skill', { file: 'review.md' })
    .startsWith('# Reviewing an installed skill'), true);
  assert.match(library.catalogue(), /^- instruction: /m);
});

// A reference the body never names is never read, so a seed that ships one is shipping dead weight.
test('names every seeded reference in its own body', () => {
  const library = new SkillLibrary({ dir: path.join(projectRoot, 'skills') });
  library.refresh();
  for (const { name, references } of library.list()) {
    const body = library.body(name);
    for (const reference of references) assert.equal(body.includes(reference), true, `${name} omits ${reference}`);
  }
  assert.deepEqual(library.list().flatMap(skill => skill.references).sort(),
    ['format.md', 'format.md', 'review.md', 'review.md']);
});
