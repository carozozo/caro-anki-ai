const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CARD_SCHEMA_VERSION,
  AI_CARD_FIELDS,
  CARD_FIELDS,
  EDITOR_FIELDS,
  EDITOR_LIST_FIELDS,
  FIELD_MAP,
  arrangeExamples,
  asPlainAnkiFields,
  orderCardFields,
  toAnkiFields,
  validateCard,
  validateCards,
} = require('../card-contract');

const validCard = {
  term: 'thickness',
  meaning: 'the quality of being thick',
  type: 'noun',
  typeLabel: 'U',
  translation: '厚度；厚實',
  implications: ['測量', '材質', '厚度'],
  literal: '',
  termUs: '',
  termUk: '',
  phonetic: '/ˈθɪknəs/',
  irregular: '',
  synonyms: ['depth'],
  antonyms: ['thinness'],
  correlations: ['thick'],
  examples: [
    { en: 'The thickness of the wall keeps the room warm.', zh: '牆壁的厚度能讓房間保持溫暖。' },
    { en: 'Check the thickness before you cut the material.', zh: '裁切材料前請先檢查厚度。' },
    { en: '<b>Thickness</b> can change how the paint dries.', zh: '厚度會影響油漆乾燥的方式。' },
  ],
};

test('validates and normalizes a card contract', () => {
  const result = validateCard({ ...validCard, implications: [' 測量 ', '', '材質', '厚度'] });
  assert.equal(CARD_SCHEMA_VERSION, '1.6');
  assert.equal(result.valid, true);
  assert.deepEqual(result.card.implications, ['測量', '材質', '厚度']);
});

test('exposes the editor contract without the structured examples field', () => {
  assert.deepEqual(EDITOR_FIELDS, CARD_FIELDS.filter(field => field !== 'examples'));
  assert.deepEqual(EDITOR_LIST_FIELDS, ['implications', 'synonyms', 'antonyms', 'correlations']);
  assert.ok(EDITOR_FIELDS.includes('implications') && !EDITOR_FIELDS.includes('examples'));
});

test('clears duplicate US and UK spellings', () => {
  const result = validateCard({ ...validCard, termUs: 'impotent', termUk: 'impotent', term: 'impotent' });
  assert.equal(result.valid, true);
  assert.equal(result.card.term, 'impotent');
  assert.equal(result.card.termUs, '');
  assert.equal(result.card.termUk, '');
});

test('rejects unsupported example HTML', () => {
  const result = validateCard({ ...validCard, examples: [{ en: '<script>alert(1)</script>', zh: '測試' }] });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /unsupported HTML/);
});

test('allows any number of valid examples on submission', () => {
  const empty = validateCard({ ...validCard, examples: [] });
  const sevenExamples = validateCard({
    ...validCard,
    examples: Array.from({ length: 7 }, () => validCard.examples[0]),
  });
  assert.equal(empty.valid, true);
  assert.equal(sevenExamples.valid, true);
});

test('requires a Traditional Chinese translation for every example', () => {
  const result = validateCard({ ...validCard, examples: validCard.examples.map(example => ({ ...example, zh: '' })) });
  assert.equal(result.valid, false);
  assert.equal(result.errors.filter(error => error.endsWith('.zh is required')).length, 3);
});

test('rejects simplified characters in every Chinese field', () => {
  const result = validateCard({ ...validCard, translation: '厚度；厚实' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('translation must use Traditional Chinese; simplified characters found: 实'));
  const example = validateCard({ ...validCard, examples: [{ en: 'A thick wall.', zh: '检查厚度。' }] });
  assert.ok(example.errors.includes('examples[0].zh must use Traditional Chinese; simplified characters found: 检'));
  assert.equal(validateCard(validCard).valid, true);
});

test('accepts skill-compatible type labels without brackets', () => {
  assert.equal(validateCard({ ...validCard, typeLabel: 'C or U' }).valid, true);
});

test('accepts reversed or-pairs and stores the canonical order', () => {
  const result = validateCard({ ...validCard, typeLabel: 'U or C' });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.card.typeLabel, 'C or U');
});

test('names the unsupported type label fragment', () => {
  const result = validateCard({ ...validCard, typeLabel: 'U or C countable' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('typeLabel contains unsupported labels: countable'));
});

test('rejects a duplicated type label', () => {
  assert.ok(validateCard({ ...validCard, typeLabel: 'C C' }).errors.includes('typeLabel contains duplicate labels'));
});

test('allows idioms to omit phonetic while requiring a literal gloss', () => {
  const result = validateCards([{
    ...validCard,
    term: 'pull out the big guns',
    meaning: 'To use the most powerful resources available.',
    type: 'idiom',
    typeLabel: '',
    translation: '使出最強手段',
    implications: ['手段', '全力', '資源'],
    literal: '拉出大砲',
    phonetic: '',
  }]);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('still requires phonetic for non-idiom cards', () => {
  const result = validateCard({ ...validCard, phonetic: '' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('phonetic is required'));
});

test('rejects the legacy AI snapshot shape seen in the workspace trace', () => {
  const result = validateCard({
    ...validCard,
    meaning: 'Powwow 原指北美原住民的聚會。',
    typeLabel: '',
    implications: [],
    examples: ['An old example.<br>（舊例句。）', 'Another example.<br>（另一句。）', 'A third example.<br>（第三句。）'],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error === 'meaning must be English'));
  assert.ok(!result.errors.some(error => error.startsWith('implications must contain')));
  assert.ok(result.errors.some(error => error.includes('examples[0].zh is required')));
});

test('maps normalized cards to Anki field names', () => {
  const result = toAnkiFields(validCard);
  assert.equal(result[FIELD_MAP.term], 'thickness');
  assert.equal(result[FIELD_MAP.meaning], 'the quality of being thick<br>厚度；厚實');
  assert.equal(result[FIELD_MAP.annotation], '');
  assert.equal(result[FIELD_MAP.example], '<b>Thickness</b> can change how the paint dries. 厚度會影響油漆乾燥的方式。<br>Check the thickness before you cut the material. 裁切材料前請先檢查厚度。<br>The thickness of the wall keeps the room warm. 牆壁的厚度能讓房間保持溫暖。');
  assert.match(result[FIELD_MAP.example], /牆壁的厚度能讓房間保持溫暖/);
});

test('sorts Anki examples by visual length without changing the card snapshot', () => {
  const examples = [
    { en: 'The unusually long example sentence is here.', zh: '這是一個很長的例句。' },
    { en: 'A short example.', zh: '短句。' },
  ];
  assert.deepEqual(arrangeExamples(examples), [examples[1], examples[0]]);
  assert.deepEqual(examples, [
    { en: 'The unusually long example sentence is here.', zh: '這是一個很長的例句。' },
    { en: 'A short example.', zh: '短句。' },
  ]);
});

test('validates a card collection with indexed errors', () => {
  const result = validateCards([validCard, { ...validCard, term: '' }]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.startsWith('cards[1].term')));
});

test('allows an empty snapshot once the last card is deleted', () => {
  assert.deepEqual(validateCards([]), { valid: true, errors: [], cards: [] });
  for (const malformed of [null, undefined, {}, 'card']) assert.equal(validateCards(malformed).valid, false);
});

test('orders JSON fields like the card back including its embedded front', () => {
  const expected = ['meaning', 'translation', 'implications', 'literal', 'annotation', 'term', 'termUs', 'termUk',
    'synonyms', 'antonyms', 'correlations', 'type', 'typeLabel', 'phonetic', 'irregular', 'examples'];
  assert.deepEqual(CARD_FIELDS, expected);
  assert.equal(AI_CARD_FIELDS.includes('annotation'), false);
  assert.deepEqual(Object.keys(orderCardFields(validCard)), expected);
  assert.deepEqual(Object.keys(validateCard(validCard).card), expected);
});

test('preserves a user annotation and exports it to Anki', () => {
  const result = validateCard({ ...validCard, annotation: '易和會議混淆' });
  assert.equal(result.valid, true);
  assert.equal(result.card.annotation, '易和會議混淆');
  assert.equal(toAnkiFields(result.card)[FIELD_MAP.annotation], '易和會議混淆');
});

test('accepts concise keywords and rejects implications over four characters', () => {
  const concise = ['北美', '原住民', '部落', '年度慶典活動', '文化'];
  assert.equal(validateCard({ ...validCard, implications: concise }).valid, false);
  const valid = validateCard({ ...validCard, implications: ['北美', '原住民', '部落', '慶典', '文化'] });
  assert.equal(valid.valid, true);
  assert.equal(toAnkiFields(valid.card)[FIELD_MAP.implication], '北美/原住民/部落/慶典/文化');
});

test('rejects malformed card shapes and unknown fields', () => {
  for (const malformed of [null, [], 1, 'word']) assert.equal(validateCards([malformed]).valid, false);
  for (const changes of [{ synonyms: 'word' }, { synonyms: [1] }, { term: 1 }, { typo: 'value' }]) {
    assert.equal(validateCard({ ...validCard, ...changes }).valid, false);
  }
});

test('renders JSON payloads into plain Anki field text', () => {
  assert.deepEqual(asPlainAnkiFields({
    [FIELD_MAP.synonym]: '["direct","guide","indicate","point out"]',
    [FIELD_MAP.implication]: '["方向","導航","交通"]',
    [FIELD_MAP.example]: '[{"en":"The path is <b>well</b> signposted.","zh":"路標很清楚。"}]',
  }), {
    [FIELD_MAP.synonym]: 'direct, guide, indicate, point out',
    [FIELD_MAP.implication]: '方向/導航/交通',
    [FIELD_MAP.example]: 'The path is <b>well</b> signposted. 路標很清楚。',
  });
});

test('leaves plain field text and non-list JSON untouched', () => {
  assert.deepEqual(asPlainAnkiFields({
    [FIELD_MAP.synonym]: 'direct, guide', [FIELD_MAP.meaning]: 'to direct', [FIELD_MAP.term]: '[bracket]word',
  }), {
    [FIELD_MAP.synonym]: 'direct, guide', [FIELD_MAP.meaning]: 'to direct', [FIELD_MAP.term]: '[bracket]word',
  });
});
