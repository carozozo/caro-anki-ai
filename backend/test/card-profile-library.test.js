const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('loads valid profile JSON files and indexes them by noteType', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-profiles-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'vocab.json'), JSON.stringify(sampleProfile('Vocab')));
    const library = new CardProfileLibrary({ dir: tmpDir });
    library.initialize();

    assert.deepEqual(library.list(), ['Vocab']);
    assert.equal(library.errors().length, 0);

    const contract = library.get('Vocab');
    assert.ok(contract);
    assert.equal(contract.noteType, 'Vocab');
    assert.deepEqual(contract.fields, ['word', 'meaning']);
    assert.deepEqual(contract.toAnkiFields({ word: 'apple', meaning: 'a fruit' }), { Front: 'apple', Back: 'a fruit' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ignores non-JSON or dotfiles and records validation errors without throwing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-profiles-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, '.ignored.json'), JSON.stringify(sampleProfile('Hidden')));
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'hello world');
    fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{ "not": "valid" }');

    const library = new CardProfileLibrary({ dir: tmpDir });
    library.initialize();

    assert.equal(library.get('Hidden'), null);
    assert.equal(library.errors().length, 1);
    assert.equal(library.errors()[0].name, 'broken.json');
    assert.match(library.errors()[0].error, /noteType is required/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('returns null when noteType profile is not found', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-profiles-test-'));
  try {
    const library = new CardProfileLibrary({ dir: tmpDir });
    library.initialize();
    assert.equal(library.get('NonExistent'), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// A profile with a labeled field and a group, which is the shape an edit is asked to touch without being
// asked to restate: everything an edit does not name has to come out exactly as it went in.
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

const withLibrary = (t, profiles = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-profiles-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, profile] of Object.entries(profiles)) {
    fs.writeFileSync(path.join(dir, name), `${JSON.stringify(profile, null, 2)}\n`);
  }
  const library = new CardProfileLibrary({ dir });
  library.initialize();
  return { dir, library };
};
const stored = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const fieldOf = (profile, name) => profile.fields.find(field => field.name === name);

test('writes a whole profile under the note type and keeps the text it replaces', t => {
  const { dir, library } = withLibrary(t, { 'Vocab.json': sampleProfile('Vocab') });
  const first = library.save({ ...sampleProfile('Vocab'), version: '2' });
  assert.deepEqual({ ...first, backup: undefined },
    { name: 'Vocab.json', noteType: 'Vocab', bytes: first.bytes, created: false, backup: undefined });
  assert.match(first.backup, /^versions\/Vocab\.json\./);
  assert.equal(stored(dir, 'Vocab.json').version, '2');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, first.backup), 'utf8')).version, undefined);
  // The write is the library's own text and the library reads it straight back: one more note type, no restart.
  assert.equal(library.get('Vocab').version, '2');
  assert.equal(library.errors().length, 0);

  const created = library.save(sampleProfile('Japanese', 'spelling'));
  assert.deepEqual({ name: created.name, created: created.created, backup: created.backup },
    { name: 'Japanese.json', created: true, backup: '' });
  assert.deepEqual(library.list(), ['Japanese', 'Vocab']);
});

test('refuses a profile the grammar rejects and writes nothing', t => {
  const { dir, library } = withLibrary(t);
  const broken = { ...sampleProfile('Vocab'), fields: [{ name: 'word', required: true }] };
  assert.throws(() => library.save(broken), error => {
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /storage\[1\]\.of names unknown field meaning/);
    return true;
  });
  assert.throws(() => library.save('{"profile":1}'), /never a JSON string/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

// The read half is what a proposal is built from, so it has to answer exactly what the write would do.
test('answers what a write would do without touching the directory', t => {
  const { dir, library } = withLibrary(t, { 'Vocab.json': labeled('Vocab') });
  const replaces = library.check(labeled('Vocab'));
  assert.deepEqual({ ...replaces, bytes: 0, content: '' },
    { name: 'Vocab.json', noteType: 'Vocab', created: false, bytes: 0, content: '' });
  assert.equal(replaces.content.endsWith('\n'), true);
  assert.equal(replaces.bytes, Buffer.byteLength(replaces.content));

  const creates = library.check(sampleProfile('Japanese'));
  assert.deepEqual({ name: creates.name, created: creates.created },
    { name: 'Japanese.json', created: true });
  assert.deepEqual(fs.readdirSync(dir), ['Vocab.json']);
});

test('edits one key of one field and leaves the rest of the file exactly as it was', t => {
  const { dir, library } = withLibrary(t, { 'Vocab.json': labeled('Vocab') });
  const edited = library.edit({ noteType: 'Vocab', field: 'typeLabel', set: { enum: ['C', 'C or U', 'usually plural'] } });
  assert.deepEqual(edited.changes, ['set typeLabel.enum']);
  assert.equal(edited.field, 'typeLabel');
  assert.match(edited.backup, /^versions\/Vocab\.json\./);
  const profile = stored(dir, 'Vocab.json');
  assert.deepEqual(fieldOf(profile, 'typeLabel').enum, ['C', 'C or U', 'usually plural']);
  assert.deepEqual(profile.groups, { phrase: ['idiom'] });
  assert.equal(profile.version, '1.6');
  assert.deepEqual(library.get('Vocab').spec('typeLabel').enum, ['C', 'C or U', 'usually plural']);
});

test('adds and removes a field with the storage that holds it', t => {
  const { dir, library } = withLibrary(t, { 'Vocab.json': labeled('Vocab') });
  library.edit({ noteType: 'Vocab', field: 'note', set: { kind: 'text' },
    storage: { field: 'Note', of: 'note' } });
  assert.deepEqual(stored(dir, 'Vocab.json').storage.at(-1), { field: 'Note', of: 'note' });
  assert.deepEqual(fieldOf(stored(dir, 'Vocab.json'), 'note'), { name: 'note', kind: 'text' });

  const removed = library.edit({ noteType: 'Vocab', field: 'note', remove: true });
  assert.deepEqual(removed.changes, ['removed note']);
  assert.deepEqual(stored(dir, 'Vocab.json').storage.map(entry => entry.field), ['Front', 'Type']);
});

test('edits the profile itself and refuses an edit that would break it', t => {
  const { dir, library } = withLibrary(t, { 'Vocab.json': labeled('Vocab') });
  assert.deepEqual(library.edit({ noteType: 'Vocab', set: { version: '1.7' } }).changes, ['set version']);
  assert.equal(stored(dir, 'Vocab.json').version, '1.7');
  // A merge that would leave the profile unreadable is the grammar's complaint, not a half-written file.
  assert.throws(() => library.edit({ noteType: 'Vocab', set: { profile: 2 } }), /profile must be 1/);
  assert.throws(() => library.edit({ noteType: 'Vocab', field: 'term', set: { required: false }, remove: true }),
    /cannot also set, unset or store it/);
  assert.throws(() => library.edit({ noteType: 'Vocab', field: 'missing', remove: true }),
    /the Vocab profile has no field named missing/);
  assert.throws(() => library.edit({ noteType: 'Vocab', storage: { field: 'Note', of: 'note' } }),
    /storage belongs to a field/);
  assert.throws(() => library.edit({ noteType: 'Vocab', field: 'typeLabel', set: { guidance: 'Pick one.' } }),
    /fields\[1\]\.guidance must list its labels with \{values\}/);
  assert.throws(() => library.edit({ noteType: 'Vocab', field: 'typeLabel' }),
    /an edit must set, unset or store at least one key/);
  assert.throws(() => library.edit({ noteType: 'Vocab', field: 'term', set: { name: 'word' } }),
    /a field is named by the key that addresses it: term, not word/);
  assert.throws(() => library.edit({ noteType: 'Japanese', field: 'typeLabel', set: { required: true } }),
    /no card profile for the Japanese note type/);
  assert.equal(stored(dir, 'Vocab.json').version, '1.7');
});

test('renames the file with the note type and rewrites the one key that ties them together', t => {
  const { dir, library } = withLibrary(t, { 'Vocab.json': labeled('Vocab') });
  const plan = library.checkRename('Vocab', 'Vocab Card');
  assert.deepEqual({ name: plan.name, to: plan.to, noteType: plan.noteType, renamed: plan.renamed },
    { name: 'Vocab.json', to: 'Vocab Card.json', noteType: 'Vocab', renamed: 'Vocab Card' });
  assert.deepEqual(fs.readdirSync(dir), ['Vocab.json']);

  const renamed = library.rename('Vocab', 'Vocab Card');
  assert.match(renamed.backup, /^versions\/Vocab\.json\./);
  assert.equal(stored(dir, 'Vocab Card.json').noteType, 'Vocab Card');
  assert.deepEqual(library.list(), ['Vocab Card']);
  assert.deepEqual(stored(dir, 'Vocab Card.json').fields, labeled('Vocab').fields);
});

test('refuses a rename onto a note type that already has a profile, and one that changes nothing', t => {
  const { dir, library } = withLibrary(t, { 'Vocab.json': labeled('Vocab'), 'Other.json': sampleProfile('Other') });
  assert.throws(() => library.rename('Vocab', 'Other'), /refusing to rename onto Other\.json/);
  assert.throws(() => library.rename('Vocab', 'Vocab'), /a rename must change the note type/);
  assert.throws(() => library.rename('Missing', 'Anything'), /no card profile for the Missing note type/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Other.json', 'Vocab.json']);
});

test('retires a profile and keeps its last text', t => {
  const { dir, library } = withLibrary(t, { 'Vocab.json': labeled('Vocab') });
  const removed = library.remove('Vocab');
  assert.equal(removed.name, 'Vocab.json');
  assert.equal(removed.noteType, 'Vocab');
  assert.match(removed.backup, /^versions\/Vocab\.json\./);
  assert.deepEqual(library.list(), []);
  assert.equal(library.get('Vocab'), null);
  assert.equal(stored(dir, removed.backup).noteType, 'Vocab');
});

test('applies all four operations through one entry point', t => {
  const { dir, library } = withLibrary(t, { 'Vocab.json': labeled('Vocab') });
  library.apply({ op: 'edit', noteType: 'Vocab', field: 'term', set: { maxChars: 40 } });
  library.apply({ op: 'rename', name: 'Vocab', to: 'Vocab Card' });
  library.apply({ op: 'write', profile: sampleProfile('Japanese') });
  library.apply({ op: 'remove', name: 'Japanese' });
  assert.deepEqual(library.list(), ['Vocab Card']);
  assert.equal(fieldOf(stored(dir, 'Vocab Card.json'), 'term').maxChars, 40);
  assert.throws(() => library.apply({ op: 'replace', profile: sampleProfile('Vocab') }),
    /unknown card profile operation: replace/);
});

