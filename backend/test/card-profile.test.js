const test = require('node:test');
const assert = require('node:assert/strict');

const { allowedTagPattern, checkProfile, compileProfile } = require('../card-profile');
const profile = require('./fixtures/english-profile.json');

// A note type that shares nothing with the profile this app ships: its own fields, its own Anki names, its own
// list separator. It exists to prove the engine is data-driven rather than shaped around one user's cards.
const foreign = {
  profile: 1,
  noteType: 'Vocab',
  fields: [
    { name: 'word', required: true },
    { name: 'senses', kind: 'list', minItems: 1, required: true },
    { name: 'note', ai: false },
  ],
  storage: [
    { field: 'Word', of: 'word' },
    { field: 'Senses', of: 'senses', join: ' | ' },
    { field: 'Note', of: 'note' },
  ],
};
const withProfile = patch => ({ ...foreign, ...patch });
// Storage that matches the given fields one-for-one, so a case can swap the field list freely.
const profileOf = fields => withProfile({
  fields,
  storage: fields.map(field => ({
    field: field.name[0].toUpperCase() + field.name.slice(1),
    of: field.name,
    ...(field.kind === 'list' ? { join: ' | ' } : {}),
  })),
});

test('compiles a note type that shares nothing with the bundled profile', () => {
  const contract = compileProfile(foreign);
  assert.deepEqual(contract.fields, ['word', 'senses', 'note']);
  assert.deepEqual(contract.aiFields, ['word', 'senses']);
  assert.deepEqual(contract.editorFields, ['word', 'senses', 'note']);
  assert.deepEqual(contract.fieldMap, { word: 'Word', senses: 'Senses', note: 'Note' });
  assert.deepEqual(contract.listSeparators, { senses: ' | ' });
  assert.deepEqual(contract.cardJsonSchema.required, ['word', 'senses']);
  assert.deepEqual(contract.toAnkiFields({ word: 'thick', senses: ['a', 'b'] }),
    { Word: 'thick', Senses: 'a | b', Note: '' });
  assert.equal(contract.validateCard({ word: 'thick', senses: ['a'] }).valid, true);
  assert.deepEqual(contract.validateCard({ word: '', senses: [] }).errors, ['word is required', 'senses is required']);
});

test('renders a stored list with the separator its own profile declares', () => {
  const contract = compileProfile(foreign);
  assert.equal(contract.asPlainAnkiValue('Senses', '["a","b"]'), 'a | b');
  assert.equal(contract.asPlainAnkiValue('Word', 'plain text'), 'plain text');
});

test('describes a note type as the profile it was compiled from', () => {
  const contract = compileProfile(foreign);
  assert.deepEqual(contract.describe(), {
    profile: 1,
    noteType: 'Vocab',
    fields: [
      { name: 'word', kind: 'text', required: true, ai: true, editor: true },
      { name: 'senses', kind: 'list', minItems: 1, required: true, ai: true, editor: true },
      { name: 'note', kind: 'text', ai: false, editor: true },
    ],
    storage: [
      { field: 'Word', of: ['word'] },
      { field: 'Senses', of: ['senses'], join: ' | ' },
      { field: 'Note', of: ['note'] },
    ],
  });
});

test('describes a profile the engine can compile back into the same contract', () => {
  const contract = compileProfile(profile);
  const described = JSON.parse(JSON.stringify(contract.describe()));
  const again = compileProfile(described);
  assert.deepEqual(checkProfile(described), []);
  assert.deepEqual(again.describe(), contract.describe());
  assert.deepEqual(again.fieldMap, contract.fieldMap);
  assert.deepEqual(again.listSeparators, contract.listSeparators);
  assert.deepEqual(again.editorFields, contract.editorFields);
  assert.deepEqual(again.cardJsonSchema, contract.cardJsonSchema);
  const card = { meaning: 'a measure of how thick something is', examples: [{ en: 'The ice is thick.', zh: '冰很厚。' }] };
  assert.deepEqual(again.toAnkiFields(card), contract.toAnkiFields(card));
});

test('rejects a profile that is not a versioned card profile', () => {
  assert.deepEqual(checkProfile({}), [
    'profile must be 1',
    'noteType is required',
    'fields must be a non-empty array',
    'storage must be a non-empty array',
  ]);
  assert.deepEqual(checkProfile(withProfile({ bogus: true })), ['profile.bogus is not supported']);
  assert.throws(() => compileProfile({}), /Card profile is invalid:\nprofile must be 1/);
});

test('rejects a field the profile never stores', () => {
  assert.deepEqual(checkProfile(withProfile({ storage: foreign.storage.slice(0, 2) })), ['field note is not stored']);
});

test('rejects a storage entry that names an unknown field', () => {
  const unknown = withProfile({ storage: [...foreign.storage, { field: 'Extra', of: 'missing' }] });
  assert.deepEqual(checkProfile(unknown), ['storage[3].of names unknown field missing']);
});

test('rejects a condition that names an unknown group', () => {
  const grouped = withProfile({
    fields: [{ name: 'word', required: true, requiredWhen: { field: 'senses', in: 'verbs' } }, ...foreign.fields.slice(1)],
  });
  assert.deepEqual(checkProfile(grouped), ['fields[0].requiredWhen must list values or name a group']);
});

test('lets a condition carry the author\'s own wording', () => {
  const conditional = profileOf([
    { name: 'word', required: true },
    { name: 'senses', kind: 'list', required: true },
    {
      name: 'note',
      requiredWhen: { field: 'word', in: ['thick'], message: 'for thick words' },
      forbiddenWhen: { field: 'word', notIn: ['thick'], message: 'unless the word is thick' },
    },
  ]);
  assert.deepEqual(checkProfile(conditional), []);
  const contract = compileProfile(conditional);
  assert.deepEqual(contract.validateCard({ word: 'thick', senses: ['a'] }).errors, ['note is required for thick words']);
  assert.deepEqual(contract.validateCard({ word: 'thin', senses: ['a'], note: 'x' }).errors,
    ['note must be empty unless the word is thick']);
  assert.deepEqual(checkProfile(profileOf([
    { name: 'word', required: true, requiredWhen: { field: 'word', in: ['x'], message: 7 } },
  ])), ['fields[0].requiredWhen.message must be a string']);
});

test('reports a bad value once, without the checks it already failed', () => {
  const contract = compileProfile(profileOf([
    { name: 'word', required: true, enum: ['thick'] },
    { name: 'senses', kind: 'list', required: true, minItems: 2 },
  ]));
  // An empty value is missing, not "unsupported"; an empty list is missing, not "too short".
  assert.deepEqual(contract.validateCard({ word: '', senses: [] }).errors, ['word is required', 'senses is required']);
  // The same value under its own rules still reports the rule it really broke.
  assert.deepEqual(contract.validateCard({ word: 'thin', senses: ['a'] }).errors,
    ['word is not supported', 'senses must contain at least 2 items']);
});

test('names the item that broke an item rule', () => {
  const contract = compileProfile(profileOf([
    { name: 'word', required: true },
    { name: 'senses', kind: 'list', script: 'zh', required: true },
  ]));
  assert.deepEqual(contract.validateCard({ word: 'thick', senses: ['厚', 'depth'] }).errors,
    ['senses[1] must be Traditional Chinese']);
});

test('rejects labels guidance that does not list its labels', () => {
  const labels = withProfile({
    fields: [{ name: 'word', enum: ['A', 'B'], enumMode: 'labels', guidance: 'Pick a label.' }, ...foreign.fields.slice(1)],
  });
  assert.deepEqual(checkProfile(labels), ['fields[0].guidance must list its labels with {values}']);
});

// The labels are a set, so the string a card stores is the profile's order rather than the model's: one
// meaning must not reach Anki as two spellings, and an alias reads back canonical.
test('stores labels in the profile\'s own order whatever order they were written in', () => {
  const contract = compileProfile(withProfile({
    fields: [{ name: 'word', enum: ['C', 'C or U', 'usually plural'], enumMode: 'labels',
      guidance: 'Pick from {values}.' }, ...foreign.fields.slice(1)],
  }));
  assert.deepEqual(contract.normalizeCard({ word: 'usually plural C' }).word, 'C usually plural');
  assert.deepEqual(contract.normalizeCard({ word: 'C usually plural' }).word, 'C usually plural');
  assert.deepEqual(contract.normalizeCard({ word: 'U or C usually plural' }).word, 'C or U usually plural');
  // An unknown fragment is left exactly as it was written, so a card that cannot be read is still reported
  // with the text that broke it.
  assert.equal(contract.normalizeCard({ word: 'C locative' }).word, 'C locative');
});

// A quoted sentence ends its row with the closing quote, so `"` has to count as punctuation; the characters
// a row may not contain are listed by the profile rather than described in prose.
test('rejects a character a row forbids, and a row that ends the wrong way', () => {
  const rows = withProfile({
    fields: [foreign.fields[0], {
      name: 'pair',
      kind: 'lines',
      item: {
        fields: [
          { name: 'a', required: true, endPunctuation: '.?!"' },
          { name: 'b', required: true, forbiddenChars: '「」' },
        ],
      },
    }],
    storage: [{ field: 'Word', of: 'word' }, { field: 'Rows', of: 'pair', join: '<br>', line: '{a} {b}' }],
  });
  assert.deepEqual(checkProfile(rows), []);
  const contract = compileProfile(rows);
  const card = pair => ({ word: 'thick', pair });
  assert.deepEqual(contract.validateCard(card([{ a: 'He said "stop."', b: 'Plain' }])).errors, []);
  assert.deepEqual(contract.validateCard(card([{ a: "He said 'stop.'", b: 'Plain' }])).errors,
    ['pair[0].a must end with punctuation']);
  assert.deepEqual(contract.validateCard(card([{ a: 'Stop!', b: '他說「停」' }])).errors,
    ['pair[0].b must not contain 「」']);
  assert.deepEqual(checkProfile(withProfile({
    fields: [foreign.fields[0], {
      name: 'pair',
      kind: 'lines',
      item: { fields: [{ name: 'a', required: true, forbiddenChars: '' }] },
    }],
    storage: [{ field: 'Word', of: 'word' }, { field: 'Rows', of: 'pair', join: '<br>', line: '{a}' }],
  })), ['fields[1].item.fields[0].forbiddenChars must list the characters a value may not contain']);
});

// The characters a value may not contain are the same statement whichever kind of field carries them, so the key
// sits on the field as well as on a row: a text value, each item of a list, and a cell all reach one check.
test('rejects a character a field forbids, and refuses it on a lines field', () => {
  const rows = withProfile({
    fields: [
      { name: 'word', required: true, forbiddenChars: '\u2019' },
      { name: 'senses', kind: 'list', required: true, forbiddenChars: '\u201c\u201d' },
      { name: 'rows', kind: 'lines', item: { fields: [{ name: 'a', required: true }] } },
    ],
    storage: [
      { field: 'Word', of: 'word' },
      { field: 'Senses', of: 'senses', join: ' | ' },
      { field: 'Rows', of: 'rows', join: '<br>', line: '{a}' },
    ],
  });
  assert.deepEqual(checkProfile(rows), []);
  const contract = compileProfile(rows);
  const card = patch => ({ word: 'thick', senses: ['\u539a'], rows: [{ a: 'Stop.' }], ...patch });
  assert.deepEqual(contract.validateCard(card({})).errors, []);
  assert.deepEqual(contract.validateCard(card({ word: 'it\u2019s thick' })).errors,
    ['word must not contain \u2019']);
  assert.deepEqual(contract.validateCard(card({ senses: ['\u201c\u539a\u201d'] })).errors,
    ['senses[0] must not contain \u201c\u201d']);
  // A lines field has no single value to apply it to, so it states the same thing on the row that does.
  assert.deepEqual(checkProfile(withProfile({
    fields: [
      foreign.fields[0],
      { name: 'rows', kind: 'lines', forbiddenChars: '\u300c\u300d', item: { fields: [{ name: 'a', required: true }] } },
    ],
    storage: [{ field: 'Word', of: 'word' }, { field: 'Rows', of: 'rows', join: '<br>', line: '{a}' }],
  })), ['fields[1].forbiddenChars is only for a text or list field; a lines field states it on its row']);
});

// Chinese punctuation is a whitelist, not a list of bans: the set a script may use is small and fixed, everything
// else is punctuation it may not, and a script's set reaches the schema the model reads as well as the check.
test('allows only the punctuation a script declares, and states it in the schema', () => {
  const fields = [
    { name: 'word', required: true },
    { name: 'senses', kind: 'list', script: 'zh', required: true },
  ];
  const allowed = { zh: '、；，。？！()/"' };
  const pun = { ...profileOf(fields), punctuation: allowed };
  assert.deepEqual(checkProfile(pun), []);
  const contract = compileProfile(pun);
  const senses = value => contract.validateCard({ word: 'thick', senses: [value] }).errors;
  assert.deepEqual(contract.describe().punctuation, allowed);
  assert.deepEqual(compileProfile(contract.describe()).describe().punctuation, allowed);
  assert.equal(contract.cardJsonSchema.properties.senses.description, 'Allowed punctuation: 、；，。？！()/"');
  for (const good of ['這塊冰很厚。', '這塊冰很厚、很寬。', '冰很厚；石頭很硬。', '他很納悶，這塊冰怎麼這麼厚。',
    '這塊冰厚嗎？', '這塊冰真厚！', '這塊冰 (ice) 很厚。', '厚的/寬的。', '他叫它 "厚"。', '他念著 "thick" 這個字。']) {
    assert.deepEqual(senses(good), [], good);
  }
  assert.deepEqual(senses('他很納悶：這塊冰怎麼這麼厚。'), ['senses[0] must not use ：']);
  assert.deepEqual(senses('這塊冰（ice）很厚。'), ['senses[0] must not use （）']);
  assert.deepEqual(senses('他說“很厚”。'), ['senses[0] must not use “”']);
  assert.deepEqual(senses('他叫它「厚」。'), ['senses[0] must not use 「」']);
  // A profile that states no set for a script checks nothing, which is how the en fields keep their own rules.
  assert.deepEqual(compileProfile(profileOf(fields)).validateCard({ word: 'thick', senses: ['厚的：粗的。'] }).errors, []);
  assert.deepEqual(checkProfile(withProfile({ punctuation: 'zh' })), ['punctuation must be an object']);
  assert.deepEqual(checkProfile(withProfile({ punctuation: { fr: '。' } })), ['punctuation.fr is not a known script']);
  assert.deepEqual(checkProfile(withProfile({ punctuation: { zh: '' } })),
    ['punctuation.zh must list the punctuation a zh value may use']);
});

test('rejects a storage line that names an unknown row', () => {
  const rows = withProfile({
    fields: [foreign.fields[0], { name: 'pair', kind: 'lines', item: { fields: [{ name: 'a', required: true }] } }],
    storage: [{ field: 'Word', of: 'word' }, { field: 'Rows', of: 'pair', join: '<br>', line: '{a} {b}' }],
  });
  assert.deepEqual(checkProfile(rows), ['storage[1].line names unknown row b']);
});

test('filters example HTML against the tags a profile allows', () => {
  assert.ok(allowedTagPattern(['b']).test('<B>bold</B>'));
  assert.equal(allowedTagPattern(['b']).test('<div>block</div>'), false);
});

test('the bundled profile is valid and drives the contract this app reads', () => {
  assert.deepEqual(checkProfile(profile), []);
  const contract = compileProfile(profile);
  assert.equal(contract.noteType, 'English');
  assert.equal(contract.version, '1.6');
  assert.deepEqual(contract.listFields, ['implications', 'synonyms', 'antonyms', 'correlations', 'examples']);
  // The schema's `required` follows the profile's own field order, so one order describes a profile everywhere.
  assert.deepEqual(Object.keys(contract.cardJsonSchema.properties),
    profile.fields.filter(field => field.ai !== false).map(field => field.name));
  assert.deepEqual(contract.cardJsonSchema.required,
    profile.fields.filter(field => field.ai !== false && field.required).map(field => field.name));
  assert.equal(contract.asPlainAnkiValue('範例', '[{"en":"A thick wall.","zh":"一道厚牆。"}]'), 'A thick wall. 一道厚牆。');
});
