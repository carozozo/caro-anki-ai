// Study options are Anki's deck options: the values a deck schedules with, held as a preset that any
// number of decks can name. Anki keeps them nested (`new`, `rev`, `lapse`), in its own units (a percentage
// as a factor, a learning step as minutes) and beside fields this app never touches, so this module is the
// one place that names the options it exposes: it reads Anki's dict into the flat values the dialog shows
// and turns the dialog's values back into the assignments the bridge applies. A field it does not name
// here can never be written.
const MAX_STEPS = 60;
const MAX_STEP_MINUTES = 365 * 1440;
const STEP_UNITS = { s: 1 / 60, m: 1, h: 60, d: 1440 };
const DEFAULT_STEP_UNIT = 'm';

const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const round = (value, digits) => Number(value.toFixed(digits));
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// `path` is where the value lives in Anki's dict and `kind` is how it is shown: a count is a whole number,
// a percent is a percentage Anki stores as a factor of `multiplier`, a choice is one of `choices`, a bool
// is a checkbox, a steps value is a delay list written as "1m 10m". The limits are this API's own guard
// around a legacy write path Anki does not validate, and each range is the one Anki's own deck options give
// that option rather than one invented here, so the guard never refuses a value Anki accepts.
const GROUPS = [
  {
    title: 'NEW CARDS',
    fields: [
      { key: 'newPerDay', label: 'New cards/day', kind: 'count', path: ['new', 'perDay'], min: 0, max: 9999 },
      {
        key: 'learningSteps', label: 'Learning steps', kind: 'steps', path: ['new', 'delays'],
        placeholder: '1m 10m', limit: { minutes: MAX_STEP_MINUTES, text: 'at most 365 days' },
      },
      {
        key: 'graduatingInterval', label: 'Graduating interval (days)', kind: 'count', path: ['new', 'ints', 0],
        min: 0, max: 9999,
      },
      {
        key: 'easyInterval', label: 'Easy interval (days)', kind: 'count', path: ['new', 'ints', 1],
        min: 0, max: 9999,
      },
      {
        key: 'startingEase', label: 'Starting ease (%)', kind: 'percent', path: ['new', 'initialFactor'],
        multiplier: 0.1, min: 131, max: 500, step: 5,
      },
      {
        key: 'newCardOrder', label: 'Insertion order', kind: 'choice', path: ['new', 'order'],
        choices: [{ value: 1, label: 'In order added' }, { value: 0, label: 'Random' }],
      },
      { key: 'buryNewSiblings', label: 'Bury new siblings', kind: 'bool', path: ['new', 'bury'] },
    ],
  },
  {
    title: 'REVIEWS',
    fields: [
      { key: 'reviewPerDay', label: 'Maximum reviews/day', kind: 'count', path: ['rev', 'perDay'], min: 0, max: 9999 },
      {
        key: 'easyBonus', label: 'Easy bonus (%)', kind: 'percent', path: ['rev', 'ease4'],
        multiplier: 100, min: 100, max: 500, step: 5,
      },
      {
        key: 'hardInterval', label: 'Hard interval (%)', kind: 'percent', path: ['rev', 'hardFactor'],
        multiplier: 100, min: 50, max: 130, step: 5,
      },
      {
        key: 'intervalModifier', label: 'Interval modifier (%)', kind: 'percent', path: ['rev', 'ivlFct'],
        multiplier: 100, min: 50, max: 200, step: 5,
      },
      {
        key: 'maximumInterval', label: 'Maximum interval (days)', kind: 'count', path: ['rev', 'maxIvl'],
        min: 1, max: 36500,
      },
      { key: 'buryReviewSiblings', label: 'Bury review siblings', kind: 'bool', path: ['rev', 'bury'] },
    ],
  },
  {
    title: 'LAPSES',
    fields: [
      {
        key: 'relearnSteps', label: 'Relearning steps', kind: 'steps', path: ['lapse', 'delays'],
        placeholder: '10m', limit: { minutes: 1440, text: 'less than 1 day' },
      },
      {
        key: 'lapseNewInterval', label: 'New interval (%)', kind: 'percent', path: ['lapse', 'mult'],
        multiplier: 100, min: 0, max: 100, step: 5,
      },
      {
        key: 'minimumLapseInterval', label: 'Minimum lapse interval (days)', kind: 'count',
        path: ['lapse', 'minInt'], min: 1, max: 9999,
      },
      {
        key: 'leechThreshold', label: 'Leech threshold', kind: 'count', path: ['lapse', 'leechFails'],
        min: 1, max: 9999,
      },
      {
        key: 'leechAction', label: 'Leech action', kind: 'choice', path: ['lapse', 'leechAction'],
        choices: [{ value: 1, label: 'Tag only' }, { value: 0, label: 'Suspend card' }],
      },
    ],
  },
  {
    title: 'ORDER & TIMER',
    fields: [
      {
        key: 'newCardMix', label: 'New cards relative to reviews', kind: 'choice', path: ['newMix'],
        choices: [{ value: 0, label: 'Mixed in' }, { value: 1, label: 'After reviews' },
          { value: 2, label: 'Before reviews' }],
      },
      {
        key: 'buryInterdayLearning', label: 'Bury interday learning siblings', kind: 'bool',
        path: ['buryInterdayLearning'],
      },
      { key: 'showAnswerTimer', label: 'Answer timer', kind: 'choice', path: ['timer'],
        choices: [{ value: 0, label: 'Off' }, { value: 1, label: 'On' }] },
      { key: 'maximumAnswerSeconds', label: 'Maximum answer seconds', kind: 'count', path: ['maxTaken'],
        min: 1, max: 7200 },
      { key: 'stopTimerOnAnswer', label: 'Stop timer on answer', kind: 'bool', path: ['stopTimerOnAnswer'] },
    ],
  },
  {
    title: 'AUDIO',
    fields: [
      { key: 'autoplayAudio', label: 'Autoplay audio', kind: 'bool', path: ['autoplay'] },
      { key: 'replayQuestionAudio', label: 'Replay question audio', kind: 'bool', path: ['replayq'] },
      { key: 'waitForAudio', label: 'Wait for audio', kind: 'bool', path: ['waitForAudio'] },
    ],
  },
  {
    title: 'FSRS',
    fields: [
      {
        key: 'desiredRetention', label: 'Desired retention (%)', kind: 'percent', path: ['desiredRetention'],
        multiplier: 100, min: 70, max: 99, step: 1,
      },
    ],
  },
];

const OPTIONS = Object.fromEntries(GROUPS.flatMap(({ fields }) => fields.map(field => [field.key, field])));
const RENDERED = ['key', 'label', 'kind', 'min', 'max', 'step', 'choices', 'placeholder'];

// What a dialog needs to draw one field: never the path or the multiplier, which are how it is written.
const renderedField = field => Object.fromEntries(RENDERED
  .filter(key => field[key] !== undefined).map(key => [key, field[key]]));

const schema = () => GROUPS.map(({ title, fields }) => ({ title, fields: fields.map(renderedField) }));

const at = (config, path) => path.reduce((value, key) => value[key], config);

const formatStep = minutes => {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${round(minutes, 2)}m`;
};

const formatSteps = delays => delays.map(formatStep).join(' ');

const readOption = (config, definition) => {
  const value = at(config, definition.path);
  if (definition.kind === 'steps') return formatSteps(value);
  if (definition.kind === 'bool') return Boolean(value);
  if (definition.kind === 'percent') return round(value * definition.multiplier, 2);
  return Number(value);
};

const readOptions = config =>
  Object.fromEntries(Object.entries(OPTIONS).map(([key, definition]) => [key, readOption(config, definition)]));

const parseSteps = (text, { label, limit }) => {
  const tokens = String(text ?? '').trim().split(/[\s,]+/).filter(Boolean);
  if (!tokens.length) fail(`${label} must name at least one step, such as 1m 10m`);
  if (tokens.length > MAX_STEPS) fail(`${label} must name at most ${MAX_STEPS} steps`);
  return tokens.map(token => {
    const match = token.match(/^(\d+(?:\.\d+)?)([smhd]?)$/i);
    if (!match) fail(`${label} must be steps such as 1m, 10m, 1h or 1d`);
    const minutes = round(Number(match[1]) * STEP_UNITS[(match[2] || DEFAULT_STEP_UNIT).toLowerCase()], 4);
    if (minutes <= 0) fail(`${label} must be greater than zero`);
    if (minutes > limit.minutes) fail(`${label} must be ${limit.text}`);
    return minutes;
  });
};

const asCount = (definition, value) => {
  const number = Number(typeof value === 'string' ? value.trim() : value);
  if (!Number.isInteger(number)) fail(`${definition.label} must be a whole number`);
  if (number < definition.min || number > definition.max) {
    fail(`${definition.label} must be from ${definition.min} to ${definition.max}`);
  }
  return number;
};

const asPercent = (definition, value) => {
  const number = Number(typeof value === 'string' ? value.trim() : value);
  if (!Number.isFinite(number)) fail(`${definition.label} must be a number`);
  if (number < definition.min || number > definition.max) {
    fail(`${definition.label} must be from ${definition.min} to ${definition.max}`);
  }
  return round(number / definition.multiplier, 4);
};

const asChoice = (definition, value) => {
  const number = Number(value);
  if (!definition.choices.some(choice => choice.value === number)) {
    fail(`${definition.label} must be one of ${definition.choices.map(choice => choice.value).join(', ')}`);
  }
  return number;
};

const asAnkiValue = (definition, value) => {
  if (definition.kind === 'steps') return parseSteps(value, definition);
  if (definition.kind === 'bool') return value === true || value === 'true' || value === 'on';
  if (definition.kind === 'percent') return asPercent(definition, value);
  if (definition.kind === 'choice') return asChoice(definition, value);
  return asCount(definition, value);
};

// The dialog sends the flat values it shows; the bridge is given one assignment per option, because a
// nested dict cannot express `new.ints[0]` without replacing the whole list.
const patchOptions = submitted => {
  if (!isPlainObject(submitted)) fail('settings must be an object of study options');
  const unknown = Object.keys(submitted).filter(key => !OPTIONS[key]);
  if (unknown.length) fail(`Unknown study option: ${unknown.join(', ')}`);
  return Object.entries(submitted).map(([key, value]) => ({
    path: OPTIONS[key].path, value: asAnkiValue(OPTIONS[key], value),
  }));
};

module.exports = { readOptions, patchOptions, schema, formatSteps, parseSteps };
