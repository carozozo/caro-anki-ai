// The bundled English profile, compiled, as the tests that pin this app's old card shape read it.
//
// Production code does not come through here. Every real path resolves a profile from the user's own
// `~/.caro-anki/card-profiles` library (`backend/card-profile-library.js`), so nothing in the app assumes a
// note type, a field name, or a word list — `backend/card-profile.js` compiles whatever a profile declares,
// and a collection whose note type nobody described simply has no contract. This module survives only because
// the tests and the audit documentation still read the bundled profile by its legacy names.
//
// It carries the legacy names the docs already read, including the singular `FIELD_MAP` keys (`synonym` for
// the `synonyms` field). New code should read `CARD_PROFILE` rather than add an alias.

const { allowedTagPattern, arrangeExamples, compileProfile } = require('./card-profile');
const profile = require('./test/fixtures/english-profile.json');

const contract = compileProfile(profile);
const spec = name => contract.spec(name);

// The singular spellings the audit reference and the existing tests use for the list fields.
const SINGULAR = {
  implication: 'implications',
  synonym: 'synonyms',
  antonym: 'antonyms',
  correlation: 'correlations',
  example: 'examples',
};
const singularOf = Object.fromEntries(Object.entries(SINGULAR).map(([singular, name]) => [name, singular]));

const CARD_SCHEMA_VERSION = contract.version;
const CARD_FIELDS = contract.fields;
const AI_CARD_FIELDS = contract.aiFields;
const ARRAY_FIELDS = contract.listFields;
const EDITOR_FIELDS = contract.editorFields;
const EDITOR_LIST_FIELDS = contract.editorListFields;
const CARD_JSON_SCHEMA = contract.cardJsonSchema;
const ALLOWED_TYPES = spec('type').enum;
const ALLOWED_TYPE_LABELS = spec('typeLabel').enum;
const PHRASE_TYPES = contract.groups.phrase;
const ALLOWED_EXAMPLE_TAGS = allowedTagPattern(spec('examples').item.fields.find(item => item.allowTags).allowTags);

const FIELD_MAP = Object.freeze(Object.fromEntries(
  Object.entries(contract.fieldMap).map(([name, field]) => [singularOf[name] ?? name, field])));
const ANKI_FIELD_MAP = Object.freeze(Object.fromEntries(
  Object.entries(contract.fieldMap).map(([name, field]) => [field, singularOf[name] ?? name])));
const LIST_SEPARATORS = Object.freeze(Object.fromEntries(
  Object.entries(contract.listSeparators).map(([name, join]) => [singularOf[name] ?? name, join])));

module.exports = {
  ALLOWED_EXAMPLE_TAGS,
  ALLOWED_TYPES,
  ALLOWED_TYPE_LABELS,
  AI_CARD_FIELDS,
  ANKI_FIELD_MAP,
  ARRAY_FIELDS,
  arrangeExamples,
  asPlainAnkiFields: contract.asPlainAnkiFields,
  asPlainAnkiValue: contract.asPlainAnkiValue,
  CARD_FIELDS,
  CARD_JSON_SCHEMA,
  CARD_PROFILE: contract,
  CARD_SCHEMA_VERSION,
  EDITOR_FIELDS,
  EDITOR_LIST_FIELDS,
  FIELD_MAP,
  LIST_SEPARATORS,
  normalizeCard: contract.normalizeCard,
  orderCardFields: contract.orderCardFields,
  PHRASE_TYPES,
  toAnkiFields: contract.toAnkiFields,
  validateCard: contract.validateCard,
  validateCards: contract.validateCards,
};
