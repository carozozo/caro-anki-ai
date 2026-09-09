const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InstructionLibrary, INSTRUCTION_LIMIT, TOPIC_NAME_LIMIT, VERSION_KEEP, TRUNCATION_MARK } =
  require('../instruction-library');

// A real directory, because the whole point of the library is what a user's files do to the prompt. It is
// left absent so the tests that care can prove `initialize()` creates it.
const fixture = t => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caro-instructions-')), 'instructions');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const write = (dir, name, content) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
};

test('creates the directory so a fresh install is ready to edit', t => {
  const dir = fixture(t);
  assert.equal(fs.existsSync(dir), false);
  const library = new InstructionLibrary({ dir });
  assert.deepEqual(library.initialize(), []);
  assert.equal(fs.existsSync(dir), true);
  assert.equal(library.prompt(), '');
});

test('an empty directory contributes nothing to the prompt', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  assert.equal(library.prompt(), '');
  assert.deepEqual(library.errors(), []);
});

test('ignores dotfiles, directories and files that are not markdown', t => {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  write(dir, 'nested/nested.md', '# Nested');
  write(dir, '.hidden.md', '# Hidden');
  write(dir, 'notes.txt', 'plain text');
  write(dir, 'real.md', '# Real');
  const library = new InstructionLibrary({ dir });
  library.initialize();
  assert.deepEqual(library.list(), ['real.md']);
  assert.match(library.prompt(), /# Real/);
  assert.doesNotMatch(library.prompt(), /Nested|Hidden|plain text/);
});

test('order is file-name ascending and every file keeps its own heading', t => {
  const dir = fixture(t);
  write(dir, 'zeta.md', 'Last.');
  write(dir, 'alpha.md', 'First.');
  write(dir, 'middle.md', 'Middle.');
  const library = new InstructionLibrary({ dir });
  library.initialize();
  assert.deepEqual(library.list(), ['alpha.md', 'middle.md', 'zeta.md']);
  const prompt = library.prompt();
  assert.match(prompt, /^## User instructions/);
  assert.equal(prompt.includes('### alpha.md\nFirst.'), true);
  assert.ok(prompt.indexOf('### alpha.md') < prompt.indexOf('### middle.md'));
  assert.ok(prompt.indexOf('### middle.md') < prompt.indexOf('### zeta.md'));
});

test('frames the files as preferences that cannot widen the tool contract', t => {
  const dir = fixture(t);
  write(dir, 'style.md', 'Cards use British spelling.');
  const library = new InstructionLibrary({ dir });
  library.initialize();
  const prompt = library.prompt();
  assert.match(prompt, /preferences, not permissions/);
  assert.match(prompt, /cannot add a tool/);
  assert.match(prompt, /writing to a note that was not read first/);
  assert.match(prompt, /govern the cards handed to the note-writing tools, not the wording of your reply/);
});

test('truncates an oversized file and marks where it stopped', t => {
  const dir = fixture(t);
  write(dir, 'huge.md', 'x'.repeat(INSTRUCTION_LIMIT + 500));
  const library = new InstructionLibrary({ dir });
  library.initialize();
  const prompt = library.prompt();
  assert.match(prompt, /…\(truncated\)$/);
  assert.equal(prompt.includes('x'.repeat(INSTRUCTION_LIMIT + 1)), false);
});

test('a directory named like an instruction is skipped, not reported as a failure', t => {
  const dir = fixture(t);
  fs.mkdirSync(dir, { recursive: true });
  write(dir, 'good.md', 'Keep going.');
  fs.mkdirSync(path.join(dir, 'broken.md'));
  const library = new InstructionLibrary({ dir });
  library.initialize();
  assert.deepEqual(library.list(), ['good.md']);
  assert.match(library.prompt(), /Keep going\./);
  // Nothing was read from it, so there is nothing to report: `errors()` is for files that exist and cannot
  // be read, and a stray folder is not one.
  assert.deepEqual(library.errors(), []);
});

test('an unreadable file is reported and never hides the others', t => {
  const dir = fixture(t);
  fs.mkdirSync(dir, { recursive: true });
  if (process.getuid?.() === 0 || process.platform === 'win32') return;
  write(dir, 'good.md', 'Keep going.');
  write(dir, 'locked.md', 'Secret.');
  fs.chmodSync(path.join(dir, 'locked.md'), 0o000);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  assert.deepEqual(library.list(), ['good.md']);
  assert.match(library.prompt(), /Keep going\./);
  assert.deepEqual(library.errors().map(failure => failure.name), ['locked.md']);
  assert.equal(typeof library.errors()[0].error, 'string');
  assert.deepEqual(library.errors(), library.errors());
});

test('a symlink to a directory is skipped without a read attempt', t => {
  const dir = fixture(t);
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') return;
  write(dir, 'good.md', 'Keep going.');
  fs.symlinkSync(dir, path.join(dir, 'linked.md'));
  const library = new InstructionLibrary({ dir });
  library.initialize();
  assert.deepEqual(library.list(), ['good.md']);
  assert.deepEqual(library.errors(), []);
});

test('an empty file stays visible to the editor without reaching the prompt', t => {
  const dir = fixture(t);
  write(dir, 'blank.md', '   \n\n');
  const library = new InstructionLibrary({ dir });
  library.initialize();
  assert.deepEqual(library.list(), ['blank.md']);
  assert.deepEqual(library.entries(), [{ name: 'blank.md', content: '' }]);
  assert.equal(library.prompt(), '');
});

test('refresh picks up an edit made while the process is running', t => {
  const dir = fixture(t);
  write(dir, 'style.md', 'Old.');
  const library = new InstructionLibrary({ dir });
  library.initialize();
  assert.match(library.prompt(), /Old\./);
  write(dir, 'style.md', 'New.');
  library.refresh();
  assert.match(library.prompt(), /New\./);
  assert.doesNotMatch(library.prompt(), /Old\./);
});

// Saving is the write side of the same contract `refresh` reads: what lands on disk must be what the next
// prompt carries, or the user's edit silently does not apply.
test('a saved instruction is written and picked up without a restart', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  const result = library.save('card-style.md', 'One sense per card.\n');

  assert.deepEqual(result, { name: 'card-style.md', bytes: 20, created: true, backup: '' });
  assert.equal(fs.readFileSync(path.join(dir, 'card-style.md'), 'utf8'), 'One sense per card.\n');
  assert.deepEqual(library.list(), ['card-style.md']);
  assert.match(library.prompt(), /### card-style\.md\nOne sense per card\./);
});

test('a save closes a missing trailing newline', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  library.save('language.md', 'Always answer in Traditional Chinese.');
  assert.equal(fs.readFileSync(path.join(dir, 'language.md'), 'utf8'), 'Always answer in Traditional Chinese.\n');
});

// The read half of a save, which is what a proposal is validated by: the same name and body rules, and the
// one thing a caller cannot work out for itself, whether the write would create a file or replace one. Nothing
// is touched — a check is not a save.
test('the read half of a save answers what it would create without writing', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  const text = 'One sense per card.';

  assert.deepEqual(library.check('card-style.md', text),
    { name: 'card-style.md', written: `${text}\n`, bytes: Buffer.byteLength(`${text}\n`, 'utf8'), created: true });
  // A body that already ends in the newline a save would close it with is the same body.
  assert.equal(library.check('card-style.md', `${text}\n`).written, `${text}\n`);
  assert.deepEqual(fs.readdirSync(dir), []);

  library.save('card-style.md', text);
  assert.equal(library.check('card-style.md', text).created, false);
  // A name the user already owns is theirs: only a brand-new file is held to the topic form.
  write(dir, 'My_Notes.md', 'Existing.');
  library.refresh();
  assert.equal(library.check('My_Notes.md', 'Edited.').created, false);
  assert.throws(() => library.check('Card Style.md', text), /lowercase topic/);
});

test('replacing an instruction keeps the text it replaced under versions/', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  library.save('style.md', 'First.');
  const result = library.save('style.md', 'Second.');

  assert.equal(result.created, false);
  assert.match(result.backup, /^versions\/style\.md\./);
  assert.equal(fs.readFileSync(path.join(dir, result.backup), 'utf8'), 'First.\n');
  assert.equal(fs.readFileSync(path.join(dir, 'style.md'), 'utf8'), 'Second.\n');
  // The backup is a directory the prompt never reads, so a kept copy cannot become a second rule.
  assert.deepEqual(library.list(), ['style.md']);
  assert.equal(library.prompt().includes('First.'), false);
});

test('only the newest versions are kept, so an edited file cannot grow without bound', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  library.save('style.md', 'v0');
  for (let index = 1; index <= 13; index++) library.save('style.md', `v${index}`);

  const kept = fs.readdirSync(path.join(dir, 'versions')).sort()
    .map(name => fs.readFileSync(path.join(dir, 'versions', name), 'utf8').trim());
  assert.equal(kept.length, VERSION_KEEP);
  assert.deepEqual(kept, Array.from({ length: VERSION_KEEP }, (_, index) => `v${index + 3}`));
});

test('a new name must read as a topic, while an existing file keeps the name it has', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  for (const name of ['Card-Style.md', 'card_style.md', 'card style.md', 'card--style.md']) {
    assert.throws(() => library.save(name, 'Rule.'), /lowercase topic/, name);
  }
  // A name the user already owns is theirs: only a brand-new file is held to the topic form.
  write(dir, 'My_Notes.md', 'Existing.');
  library.refresh();
  assert.equal(library.save('My_Notes.md', 'Edited.').created, false);
  assert.equal(fs.readFileSync(path.join(dir, 'My_Notes.md'), 'utf8'), 'Edited.\n');
});

test('rejects a name that would leave the directory or be read as something else', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  for (const name of ['../escape.md', 'nested/child.md', 'nested\\child.md', '.hidden.md', 'notes.txt', '']) {
    assert.throws(() => library.save(name, 'Rule.'), /invalid instruction name|must end in \.md|name is required/, name);
  }
  assert.throws(() => library.save(`${'a'.repeat(TOPIC_NAME_LIMIT + 1)}.md`, 'Rule.'), /exceeds/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('keeps an empty instruction as a draft and rejects one the prompt would silently truncate', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  assert.deepEqual(library.save('style.md', ''), { name: 'style.md', bytes: 0, created: true, backup: '' });
  assert.equal(fs.readFileSync(path.join(dir, 'style.md'), 'utf8'), '');
  assert.deepEqual(library.list(), ['style.md']);
  assert.equal(library.prompt(), '');
  assert.throws(() => library.save('style.md', 'x'.repeat(INSTRUCTION_LIMIT + 1)), /silently truncate/);
  assert.equal(fs.existsSync(path.join(dir, 'style.md')), true);
});

test('accepts a body of exactly the limit, which the prompt still carries whole', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  const body = 'x'.repeat(INSTRUCTION_LIMIT);
  library.save('huge.md', body);
  assert.equal(library.prompt().includes(body), true);
  assert.equal(library.prompt().includes(TRUNCATION_MARK), false);
});

test('refuses to save over a symlink or a directory rather than follow it', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  if (process.platform !== 'win32') {
    const outside = path.join(dir, '..', 'outside.md');
    t.after(() => fs.rmSync(outside, { force: true }));
    fs.writeFileSync(outside, 'Outside.');
    fs.symlinkSync(outside, path.join(dir, 'linked.md'));
    assert.throws(() => library.save('linked.md', 'Rule.'), /symlink/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'Outside.');
  }
  fs.mkdirSync(path.join(dir, 'folder.md'));
  assert.throws(() => library.save('folder.md', 'Rule.'), /not a file/);
});

test('a failed write leaves the previous instruction in place and no temporary behind', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  library.save('style.md', 'Keep me.');
  // Two saves put `versions/` in place, so the read-only directory fails the replacement itself rather than
  // the backup before it — the step the atomic rename exists to protect.
  library.save('style.md', 'Keep me.');
  if (process.getuid?.() === 0 || process.platform === 'win32') return;
  fs.chmodSync(dir, 0o500);
  try {
    assert.throws(() => library.save('style.md', 'Lose me.'), error => error.code === 'EACCES');
  } finally { fs.chmodSync(dir, 0o700); }
  assert.equal(fs.readFileSync(path.join(dir, 'style.md'), 'utf8'), 'Keep me.\n');
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
  library.refresh();
  assert.match(library.prompt(), /Keep me\./);
});

// A rename is a name change and nothing more, so the text is the same text: the file moves, the old name stops
// applying, and the next turn reads the same rule under its new heading.
test('a rename moves the file, keeps its text, and keeps the old name under versions/', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  const text = 'Answer in Traditional Chinese.\n';
  library.save('language.md', text);

  assert.deepEqual(library.checkRename('language.md', 'reply-language.md'),
    { name: 'language.md', to: 'reply-language.md', bytes: Buffer.byteLength(text, 'utf8') });
  const result = library.rename('language.md', 'reply-language.md');
  assert.match(result.backup, /^versions\/language\.md\./);
  assert.equal(fs.readFileSync(path.join(dir, result.backup), 'utf8'), text);
  assert.equal(fs.readFileSync(path.join(dir, 'reply-language.md'), 'utf8'), text);
  assert.equal(fs.existsSync(path.join(dir, 'language.md')), false);
  // The heading is the filename, so the prompt carries the rule once, under the name it now has.
  assert.match(library.prompt(), /### reply-language\.md\nAnswer in Traditional Chinese\./);
  assert.doesNotMatch(library.prompt(), /### language\.md/);
});

// Everything a rename must refuse: a target the user already has, a target that would not read as a topic, a
// no-op, and a source that is not there. None of them touches the directory.
test('a rename refuses a taken target, a non-topic, a no-op and a missing source', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  library.save('language.md', 'A.');
  library.save('tone.md', 'B.');
  assert.throws(() => library.rename('language.md', 'tone.md'), /refusing to rename onto tone\.md/);
  assert.throws(() => library.rename('language.md', 'Reply.md'), /lowercase topic/);
  assert.throws(() => library.rename('language.md', 'language.md'), /must change the name/);
  assert.throws(() => library.rename('missing.md', 'reply.md'), /no such instruction: missing\.md/);
  assert.throws(() => library.rename('../escape.md', 'reply.md'), /invalid instruction name/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['language.md', 'tone.md']);
});

// Retiring a rule is the operation the user asks for by name, and it is reversible: the last text is kept
// where a replacement's is, and the file stops being read.
test('a removal deletes the file, keeps its text, and reads as finished', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  const text = 'Reply in Chinese.\n';
  library.save('old.md', text);

  assert.deepEqual(library.checkRemove('old.md'),
    { name: 'old.md', bytes: Buffer.byteLength(text, 'utf8') });
  const result = library.remove('old.md');
  assert.match(result.backup, /^versions\/old\.md\./);
  assert.equal(fs.readFileSync(path.join(dir, result.backup), 'utf8'), text);
  assert.equal(fs.existsSync(path.join(dir, 'old.md')), false);
  assert.equal(library.prompt(), '');
});

test('a removal refuses a file that is not there, a directory, and a name that escapes', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  assert.throws(() => library.remove('missing.md'), /no such instruction: missing\.md/);
  assert.throws(() => library.remove('nested/child.md'), /invalid instruction name/);
  fs.mkdirSync(path.join(dir, 'folder.md'));
  assert.throws(() => library.remove('folder.md'), /not an instruction file: folder\.md/);
  assert.equal(fs.existsSync(path.join(dir, 'folder.md')), true);
});

// The agent asks by operation rather than by method, so the vocabulary of what can be done to this directory
// lives here — and a call that only saves files keeps working by leaving `op` out.
test('applies every operation through one vocabulary', t => {
  const dir = fixture(t);
  const library = new InstructionLibrary({ dir });
  library.initialize();
  assert.equal(library.apply({ name: 'old.md', content: 'Rule.' }).created, true);
  assert.equal(library.apply({ op: 'rename', name: 'old.md', to: 'rule.md' }).to, 'rule.md');
  assert.equal(library.apply({ op: 'remove', name: 'rule.md' }).name, 'rule.md');
  assert.deepEqual(fs.readdirSync(dir), ['versions']);
  assert.deepEqual(library.list(), []);
  // An operation the library does not know is the caller's error, and nothing is written for it.
  assert.throws(() => library.apply({ op: 'archive', name: 'rule.md' }),
    /unknown instruction operation: archive/);
});
