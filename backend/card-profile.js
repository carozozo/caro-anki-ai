// The card profile engine.
//
// A profile is data: which note type, which logical fields it has, how each one reaches Anki, and which
// checks apply. This module turns a profile into the operations the app runs — validation, normalization,
// Anki field mapping, and the JSON schema handed to the model — and names no note type, language, field or
// word of its own. A user describes their cards in their own profile, under
// `~/.caro-anki/card-profiles/<NoteType>.json` (`config.cardProfilesDir`); the bundled
// `backend/test/fixtures/english-profile.json` is this app's own template, kept as data rather than a special
// case.
//
// `compileProfile(profile)` returns the contract, and `contract.describe()` hands the profile back in the
// grammar below — every default filled in, nothing of the engine's own added. The keys documented here are
// therefore also what an agent reads to learn a note type it has never seen.
//
// Profile keys
//   profile             1 (required)
//   noteType            the Anki note type this profile describes (required)
//   version             opaque version string, surfaced to the app as CARD_SCHEMA_VERSION
//   groups              named value lists a condition can point at: { "phrase": ["idiom", "..."] }
//   fields              the logical fields, in order (required)
//   storage             how those fields reach Anki's fields, in order (required)
//   collapseDuplicates  [ { keep, fields } ] — blank the others when every listed field agrees
//   punctuation         { zh: '、；，。？！()/"' } — the only punctuation a value of that script may use;
//                       any other punctuation character in such a value is reported
//
// Field keys
//   name                logical name, and the key the model returns (required, unique)
//   kind                text | list | lines (default text)
//   required            the value, or at least one item, must be present
//   ai                  false keeps it out of the model's schema (default true)
//   editor              false keeps it out of the editor surface (default true)
//   guidance            the description the model reads for this field
//   enum                closed list of allowed values; `{values}` in guidance expands to it
//   enumMode            value | labels — `labels` reads space-separated canonical labels, so `A or B` also
//                       accepts `B or A` and stores the canonical `A or B`
//   pattern             regex the value must match, complained about with `patternMessage`
//   script              en | zh — a value that must not hold Han, or one that must
//   traditional         true rejects characters Taiwan Traditional Chinese never uses
//   minItems, maxItems  bounds on how many items a list holds
//   maxChars            longest one value, or one item, may be
//   forbiddenChars      characters no value of this field may contain at all, whichever script it is written
//                       in; a lines field states it on the row instead, because its cells are its values
//   requiredWhen,       { field, in | notIn, message } — a condition on another field's value; `in`/`notIn` may
//     forbiddenWhen     name a group instead of listing values, and `message` is appended to the complaint in
//                       the author's own words ("for idioms and phrasal verbs")
//   sort                visualLength — orders a lines field shortest line first on the way to Anki
//   item                a lines field's row shape:
//                       { fields: [ { name, required, guidance, script, traditional, allowTags,
//                                     endPunctuation, widePunctuation, forbiddenChars } ] }
//                       A cell's `forbiddenChars` is the row-level spelling of the field-level key, so how a
//                       preference about characters is stated never depends on the field's kind.
//
// Storage keys
//   field               the Anki field name (required, unique)
//   of                  the logical field(s) it holds, in write order (required)
//   join                what separates those parts, and a list field's items
//   line                a lines field's row template, e.g. "{en} {zh}"
//   stripEnds           characters to drop from either end of the written value
//
// Validation reports the fewest messages that explain a card, so one value is complained about once: an empty
// value is missing rather than "unsupported" or "not Traditional Chinese", a required list that is missing is
// not also too short, and an item rule names the item it broke (`examples[1].zh is required`) instead of the
// whole field. A field's `requiredWhen.message` / `forbiddenWhen.message` is the profile author's own wording
// for a condition, so the profile — not this engine — decides how the condition reads.

const PROFILE_VERSION = 1;
const KINDS = ['text', 'list', 'lines'];
const SCRIPTS = ['en', 'zh'];
const ENUM_MODES = ['value', 'labels'];
const SORTS = ['visualLength'];
const PROFILE_KEYS = [
  'profile', 'noteType', 'version', 'groups', 'fields', 'storage', 'collapseDuplicates', 'punctuation',
];
const FIELD_KEYS = [
  'name', 'kind', 'required', 'ai', 'editor', 'guidance', 'enum', 'enumMode', 'pattern', 'patternMessage',
  'script', 'traditional', 'minItems', 'maxItems', 'maxChars', 'forbiddenChars', 'requiredWhen', 'forbiddenWhen',
  'sort', 'item',
];
const ITEM_FIELD_KEYS = [
  'name', 'required', 'guidance', 'script', 'traditional', 'allowTags', 'endPunctuation', 'widePunctuation',
  'forbiddenChars',
];
const CONDITION_KEYS = ['field', 'in', 'notIn', 'message'];
const STORAGE_KEYS = ['field', 'of', 'join', 'line', 'stripEnds'];
const DUPLICATE_KEYS = ['keep', 'fields'];
const NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const TAG_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const HAN = /\p{Script=Han}/u;
const ANY_TAG = /<[^>]*>/g;
const HALF_WIDTH = /[,.;:?!()]/;
// Any Unicode punctuation mark, full-width or not: one test decides whether a character is punctuation at all,
// so a whitelist can be stated as the characters that are allowed instead of every character that is not.
const PUNCTUATION = /\p{P}/u;
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
const JSON_START = /^[[{]/;

// Characters Taiwan Traditional Chinese never uses. Seeing one proves the model wrote PRC Chinese instead,
// the clearest mechanical sign of machine-translated output. Deliberately excludes characters Traditional
// Chinese also uses legitimately: 台 只 后 里 面 干 划 松 才 于 余 准 够 范 胡 斗 冲 无 内 册 几 瘦.
const SIMPLIFIED_ONLY = new Set(
  '爱碍亚优伟伤体备毕边变标别宾补报贝闭笔币帮宝坝参产长尝场车彻陈称础处传创纯词辞错达担单当导岛灯点电东动冻独读断'
  + '队对夺额儿发访飞费纷风复负妇盖刚钢给个巩沟构购顾关观广归国过华画怀欢环还换汇会获击积机极级挤计记纪济夹价坚监检简'
  + '见讲奖节结紧进经静旧剧觉决绝军开课垦矿来兰览蓝劳乐类礼历联连练粮疗领龙楼罗论马吗买卖满么门们梦灭庙难脑拟宁农盘'
  + '赔频评规齐骑岂气迁钱签桥亲轻庆穷区劝权让热认荣软扫杀设师时实识试势视适释书术树数双谁顺说硕丝苏诉随岁孙缩锁态谈'
  + '叹汤讨题条铁听统继维绿线统头图团网卫温闻问务误雾习细戏现乡详响项写谢兴须许续选学压严颜阳养样药爷业页遗亿艺议译'
  + '阴银应营赢邮犹鱼与语预员圆远愿约云运杂灾赞脏责则择泽战张帐赵这诊镇争郑证织职执种众钟终转装状资总组钻专临举为义'
  + '间将该没询诚训诗灵炼码稳竞篮紧县号园围块拥挂据损显违迟逻镜键顶饭饮饰驾验龄鸡丰丽庄厌厉乌乔乱亏仅从仓仪侠侧储'
  + '兽况净凉办医协叙忧');

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asText = value => (typeof value === 'string' ? value.trim() : '');
const asStrings = value => (Array.isArray(value) ? value.map(asText).filter(Boolean) : []);
const asNames = value => (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(asText).filter(Boolean);
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeClass = value => value.replace(/[^A-Za-z0-9 ]/g, '\\$&');
const allowedTagPattern = tags => new RegExp(`</?(?:${tags.map(escapePattern).join('|')})\\b[^>]*>`, 'gi');

// How wide a line looks in the Anki browser, so the shortest one can be shown first. Han counts double,
// capitals a little more than lowercase, and narrow letters barely at all.
function visualLength (value) {
  return [...value.replace(ANY_TAG, '')].reduce((length, char) => {
    if (HAN.test(char)) return length + 2.5;
    if (/[a-z]/i.test(char) && char === char.toUpperCase()) return length + 2;
    if (['i', 'j', '.'].includes(char)) return length + 0.25;
    return length + 1;
  }, 0);
}

const arrangeByLength = (rows, render) => [...rows]
  .sort((left, right) => visualLength(render(left)) - visualLength(render(right)));

const arrangeExamples = examples => arrangeByLength(examples, example => `${example.en} ${example.zh}`);

// `A or B` is printed with its pair in either order, so both orders resolve to the canonical one.
function labelAliases (labels) {
  const aliases = new Map();
  for (const label of labels) {
    aliases.set(label, label);
    const [left, right] = label.split(' or ');
    if (right) aliases.set(`${right} or ${left}`, label);
  }
  return aliases;
}

// Greedy longest-match parse of a space-separated label string. Returns the canonical labels plus the first
// fragment that is not a known label (empty when the whole value parses).
function parseLabels (value, index) {
  const labels = [];
  let remaining = value;
  while (remaining) {
    const alias = index.candidates.find(candidate => remaining === candidate || remaining.startsWith(`${candidate} `));
    if (!alias) return { labels, unknown: remaining };
    labels.push(index.aliases.get(alias));
    remaining = remaining.slice(alias.length).trim();
  }
  return { labels, unknown: '' };
}

function pushUnknown (label, value, keys, errors) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`${label}.${key} is not supported`);
}

function checkCondition (label, condition, names, groups, errors) {
  if (condition === undefined) return;
  if (!isObject(condition)) return errors.push(`${label} must be an object`);
  pushUnknown(label, condition, CONDITION_KEYS, errors);
  if (!names.includes(condition.field)) errors.push(`${label}.field must name a field`);
  if ((condition.in === undefined) === (condition.notIn === undefined)) {
    return errors.push(`${label} must have exactly one of in, notIn`);
  }
  const values = condition.in ?? condition.notIn;
  const known = typeof values === 'string' ? Array.isArray(groups[values]) : asNames(values).length > 0;
  if (!known) errors.push(`${label} must list values or name a group`);
  if (condition.message !== undefined && !asText(condition.message)) errors.push(`${label}.message must be a string`);
}

function conditionSuffix (condition) {
  const message = asText(condition.message);
  return message ? ` ${message}` : '';
}

function checkItemField (item, label, errors) {
  if (!isObject(item)) return errors.push(`${label} must be an object`);
  pushUnknown(label, item, ITEM_FIELD_KEYS, errors);
  if (!NAME.test(asText(item.name))) errors.push(`${label}.name must be a letter followed by letters or digits`);
  for (const key of ['required', 'traditional', 'widePunctuation']) {
    if (item[key] !== undefined && typeof item[key] !== 'boolean') errors.push(`${label}.${key} must be a boolean`);
  }
  if (item.script !== undefined && !SCRIPTS.includes(item.script)) {
    errors.push(`${label}.script must be one of ${SCRIPTS.join(', ')}`);
  }
  if (item.allowTags !== undefined && !asNames(item.allowTags).every(tag => TAG_NAME.test(tag))) {
    errors.push(`${label}.allowTags must list HTML tag names`);
  }
  if (item.endPunctuation !== undefined && !asText(item.endPunctuation)) {
    errors.push(`${label}.endPunctuation must list the characters a value may end with`);
  }
  if (item.forbiddenChars !== undefined && !asText(item.forbiddenChars)) {
    errors.push(`${label}.forbiddenChars must list the characters a value may not contain`);
  }
}

function checkField (field, index, errors) {
  const label = `fields[${index}]`;
  if (!isObject(field)) return errors.push(`${label} must be an object`);
  pushUnknown(label, field, FIELD_KEYS, errors);
  if (!NAME.test(asText(field.name))) errors.push(`${label}.name must be a letter followed by letters or digits`);
  const kind = field.kind ?? 'text';
  if (!KINDS.includes(kind)) errors.push(`${label}.kind must be one of ${KINDS.join(', ')}`);
  for (const key of ['required', 'ai', 'editor', 'traditional']) {
    if (field[key] !== undefined && typeof field[key] !== 'boolean') errors.push(`${label}.${key} must be a boolean`);
  }
  if (field.script !== undefined && !SCRIPTS.includes(field.script)) {
    errors.push(`${label}.script must be one of ${SCRIPTS.join(', ')}`);
  }
  if (field.enum !== undefined && !asNames(field.enum).length) errors.push(`${label}.enum must be a non-empty array`);
  if (field.enumMode !== undefined && !ENUM_MODES.includes(field.enumMode)) {
    errors.push(`${label}.enumMode must be one of ${ENUM_MODES.join(', ')}`);
  }
  if (field.enumMode !== undefined && field.enum === undefined) errors.push(`${label}.enumMode needs enum`);
  if (field.enumMode === 'labels' && !asText(field.guidance).includes('{values}')) {
    errors.push(`${label}.guidance must list its labels with {values}`);
  }
  if (asText(field.guidance).includes('{values}') && field.enum === undefined) {
    errors.push(`${label}.guidance uses {values} without an enum`);
  }
  if (field.pattern !== undefined) {
    try { new RegExp(field.pattern); } catch { errors.push(`${label}.pattern is not a regular expression`); }
  }
  if (field.sort !== undefined && !SORTS.includes(field.sort)) errors.push(`${label}.sort must be one of ${SORTS.join(', ')}`);
  if (field.forbiddenChars !== undefined && !asText(field.forbiddenChars)) {
    errors.push(`${label}.forbiddenChars must list the characters a value may not contain`);
  }
  if (kind === 'lines' && field.forbiddenChars !== undefined) {
    errors.push(`${label}.forbiddenChars is only for a text or list field; a lines field states it on its row`);
  }
  for (const key of ['minItems', 'maxItems', 'maxChars']) {
    if (field[key] !== undefined && !(Number.isInteger(field[key]) && field[key] > 0)) {
      errors.push(`${label}.${key} must be a positive integer`);
    }
  }
  if (kind !== 'lines' && field.item !== undefined) errors.push(`${label}.item is only for a lines field`);
  if (kind === 'lines') {
    if (!isObject(field.item) || !Array.isArray(field.item.fields) || !field.item.fields.length) {
      errors.push(`${label}.item.fields must be a non-empty array`);
    } else {
      pushUnknown(`${label}.item`, field.item, ['fields'], errors);
      const items = field.item.fields;
      items.forEach((item, position) => checkItemField(item, `${label}.item.fields[${position}]`, errors));
      const names = items.map(item => asText(item?.name)).filter(Boolean);
      if (names.length !== items.length) return;
      if (new Set(names).size !== names.length) errors.push(`${label}.item.fields names must be unique`);
    }
  }
}

function checkStorage (storage, fields, errors) {
  const ankiNames = new Set();
  const owners = new Map();
  const index = new Map(fields.map(field => [field.name, field]));
  storage.forEach((entry, position) => {
    const label = `storage[${position}]`;
    if (!isObject(entry)) return errors.push(`${label} must be an object`);
    pushUnknown(label, entry, STORAGE_KEYS, errors);
    const field = asText(entry.field);
    if (!field) errors.push(`${label}.field is required`);
    else if (ankiNames.has(field)) errors.push(`${label}.field repeats ${field}`);
    else ankiNames.add(field);
    const parts = asNames(entry.of);
    if (!parts.length) errors.push(`${label}.of must name a field`);
    for (const name of parts) {
      if (!index.has(name)) errors.push(`${label}.of names unknown field ${name}`);
      else if (owners.has(name)) errors.push(`${label}.of repeats ${name}`);
      else owners.set(name, entry);
    }
    const kinds = new Set(parts.filter(name => index.has(name)).map(name => index.get(name).kind ?? 'text'));
    if (kinds.size > 1) errors.push(`${label}.of must hold parts of one kind`);
    const single = parts.length === 1 ? index.get(parts[0]) : undefined;
    const singleKind = single?.kind ?? 'text';
    if (parts.length > 1 && !entry.join) errors.push(`${label}.join is required for more than one part`);
    if (single && singleKind !== 'text' && !entry.join) errors.push(`${label}.join is required for a ${singleKind} field`);
    if (entry.line === undefined) return;
    if (singleKind !== 'lines') return errors.push(`${label}.line is only for a lines field`);
    const known = single.item.fields.map(item => asText(item.name));
    for (const [, key] of asText(entry.line).matchAll(PLACEHOLDER)) {
      if (!known.includes(key)) errors.push(`${label}.line names unknown row ${key}`);
    }
  });
  for (const field of fields) {
    if (!owners.has(field.name)) errors.push(`field ${field.name} is not stored`);
  }
}

function checkProfile (profile) {
  if (!isObject(profile)) return ['profile must be an object'];
  const errors = [];
  pushUnknown('profile', profile, PROFILE_KEYS, errors);
  if (profile.profile !== PROFILE_VERSION) errors.push(`profile must be ${PROFILE_VERSION}`);
  if (!asText(profile.noteType)) errors.push('noteType is required');
  if (profile.version !== undefined && !asText(profile.version)) errors.push('version must be a string');

  const punctuation = profile.punctuation ?? {};
  if (!isObject(punctuation)) errors.push('punctuation must be an object');
  else for (const [script, chars] of Object.entries(punctuation)) {
    if (!SCRIPTS.includes(script)) errors.push(`punctuation.${script} is not a known script`);
    else if (!asText(chars)) errors.push(`punctuation.${script} must list the punctuation a ${script} value may use`);
  }

  const groups = profile.groups ?? {};
  if (!isObject(groups)) errors.push('groups must be an object');
  else {
    for (const [name, values] of Object.entries(groups)) {
      if (!NAME.test(name)) errors.push(`groups.${name} is not a valid group name`);
      if (!asNames(values).length) errors.push(`groups.${name} must be a non-empty array`);
    }
  }

  const fields = Array.isArray(profile.fields) ? profile.fields : [];
  if (!fields.length) errors.push('fields must be a non-empty array');
  fields.forEach((field, position) => checkField(field, position, errors));
  const names = fields.map(field => asText(field?.name)).filter(Boolean);
  if (new Set(names).size !== names.length) errors.push('field names must be unique');
  fields.forEach((field, position) => {
    if (!isObject(field)) return;
    checkCondition(`fields[${position}].requiredWhen`, field.requiredWhen, names, groups, errors);
    checkCondition(`fields[${position}].forbiddenWhen`, field.forbiddenWhen, names, groups, errors);
  });

  const storage = Array.isArray(profile.storage) ? profile.storage : [];
  if (!storage.length) errors.push('storage must be a non-empty array');
  else if (fields.length === names.length) checkStorage(storage, fields, errors);

  const duplicates = profile.collapseDuplicates ?? [];
  if (!Array.isArray(duplicates)) errors.push('collapseDuplicates must be an array');
  else duplicates.forEach((rule, position) => {
    const label = `collapseDuplicates[${position}]`;
    if (!isObject(rule)) return errors.push(`${label} must be an object`);
    pushUnknown(label, rule, DUPLICATE_KEYS, errors);
    const listed = asNames(rule.fields);
    if (listed.length < 2) errors.push(`${label}.fields must name at least two fields`);
    for (const name of listed) if (!names.includes(name)) errors.push(`${label}.fields names unknown field ${name}`);
    if (!listed.includes(rule.keep)) errors.push(`${label}.keep must name one of its fields`);
  });

  return errors;
}

function compileProfile (profile) {
  const errors = checkProfile(profile);
  if (errors.length) throw new Error(`Card profile is invalid:\n${errors.join('\n')}`);

  const specs = profile.fields.map(field => Object.freeze({
    kind: 'text', enumMode: 'value', ai: true, editor: true, ...field,
  }));
  const byName = new Map(specs.map(spec => [spec.name, spec]));
  const groups = profile.groups ?? {};
  const punctuation = profile.punctuation ?? {};
  const labelIndex = new Map(specs.filter(spec => spec.enumMode === 'labels').map(spec => {
    const aliases = labelAliases(spec.enum);
    // The labels are a set, so the profile's own declaration order is the one they are stored in: the order
    // the model happened to write them in is not part of the card.
    const order = new Map(spec.enum.map((label, position) => [label, position]));
    return [spec.name, { aliases, order,
      candidates: [...aliases.keys()].sort((left, right) => right.length - left.length) }];
  }));

  const storage = profile.storage.map(entry => ({ ...entry, parts: asNames(entry.of) }));
  const storedBy = new Map(storage.map(entry => [entry.field, entry]));
  for (const entry of storage) for (const name of entry.parts) storedBy.set(name, entry);
  const itemNames = spec => spec.item.fields.map(item => item.name);
  const emptyValue = spec => (spec.kind === 'text' ? '' : []);
  const hasValue = (spec, value) => (spec.kind === 'text' ? Boolean(value) : value.length > 0);

  const conditionValues = condition => asNames(
    Array.isArray(condition.in ?? condition.notIn) ? condition.in ?? condition.notIn : groups[condition.in ?? condition.notIn]);
  const applies = (condition, normalized) => {
    const other = normalized[condition.field];
    const values = conditionValues(condition);
    const hit = Array.isArray(other) ? other.some(value => values.includes(value)) : values.includes(other);
    return condition.in === undefined ? !hit : hit;
  };

  const asRows = (spec, value) => {
    if (!Array.isArray(value)) return [];
    const keys = itemNames(spec);
    return value.map(row => {
      const source = isObject(row) ? row : { [keys[0]]: row };
      return Object.fromEntries(keys.map(key => [key, asText(source[key])]));
    });
  };

  const normalizeValue = (spec, value) =>
    (spec.kind === 'list' ? asStrings(value) : spec.kind === 'lines' ? asRows(spec, value) : asText(value));

  function normalizeCard (card = {}) {
    const normalized = Object.fromEntries(specs.map(spec => [spec.name, normalizeValue(spec, card[spec.name])]));
    for (const rule of profile.collapseDuplicates ?? []) {
      const spellings = rule.fields.map(name => String(normalized[name]).toLocaleLowerCase());
      if (!spellings.every(value => value && value === spellings[0])) continue;
      for (const name of rule.fields) {
        if (name !== rule.keep) normalized[name] = emptyValue(byName.get(name));
      }
    }
    for (const [name, index] of labelIndex) {
      const parsed = parseLabels(normalized[name], index);
      // `usually plural C` and `C usually plural` are the same card, so both are stored as the one spelling
      // the profile declares — otherwise the same value reaches Anki two ways and no two cards compare equal.
      if (!parsed.unknown) {
        normalized[name] = [...parsed.labels]
          .sort((left, right) => index.order.get(left) - index.order.get(right)).join(' ');
      }
    }
    return normalized;
  }

  const simplified = value => [...new Set([...value].filter(char => SIMPLIFIED_ONLY.has(char)))];

  function checkValue (spec, value, label, errors) {
    if (!value) return;
    if (spec.script === 'en' && HAN.test(value)) errors.push(`${label} must be English`);
    if (spec.script === 'zh' && !HAN.test(value)) errors.push(`${label} must be Traditional Chinese`);
    if (spec.traditional) {
      const found = simplified(value);
      if (found.length) errors.push(`${label} must use Traditional Chinese; simplified characters found: ${found.join('')}`);
    }
    const allowed = punctuation[spec.script];
    if (allowed) {
      const found = [...new Set([...value].filter(char => PUNCTUATION.test(char) && !allowed.includes(char)))];
      if (found.length) errors.push(`${label} must not use ${found.join('')}`);
    }
    if (spec.forbiddenChars) {
      const found = [...new Set([...value].filter(char => spec.forbiddenChars.includes(char)))];
      if (found.length) errors.push(`${label} must not contain ${found.join('')}`);
    }
    if (spec.maxChars && [...value].length > spec.maxChars) {
      errors.push(`${label} must be at most ${spec.maxChars} characters`);
    }
  }

  function checkItemValue (item, value, label, errors) {
    if (!value) {
      if (item.required) errors.push(`${label} is required`);
      return;
    }
    if (item.allowTags && value.replace(allowedTagPattern(item.allowTags), '').match(ANY_TAG)) {
      errors.push(`${label} contains unsupported HTML`);
    }
    checkValue(item, value, label, errors);
    if (item.endPunctuation && ![...item.endPunctuation].includes(value.at(-1))) {
      errors.push(`${label} must end with punctuation`);
    }
    if (item.widePunctuation && HALF_WIDTH.test(value)) errors.push(`${label} must use full-width punctuation`);
  }

  function validateField (spec, value, errors, normalized) {
    const name = spec.name;
    if (spec.required && !hasValue(spec, value)) errors.push(`${name} is required`);
    if (spec.kind === 'text') checkValue(spec, value, name, errors);
    if (spec.kind === 'list') value.forEach((item, position) => checkValue(spec, item, `${name}[${position}]`, errors));
    if (spec.kind === 'lines') {
      value.forEach((row, position) => spec.item.fields.forEach(item => checkItemValue(item, row[item.name],
        `${name}[${position}].${item.name}`, errors)));
    }
    // A required list that is missing has already reported itself, so a count would only repeat it.
    const missingList = spec.kind !== 'text' && spec.required && value.length === 0;
    if (!missingList && spec.kind !== 'text' && (spec.minItems !== undefined || spec.maxItems !== undefined)) {
      if (spec.minItems !== undefined && spec.maxItems !== undefined
        && (value.length < spec.minItems || value.length > spec.maxItems)) {
        errors.push(`${name} must contain ${spec.minItems}–${spec.maxItems} items`);
      } else if (spec.minItems !== undefined && value.length < spec.minItems) {
        errors.push(`${name} must contain at least ${spec.minItems} items`);
      } else if (spec.maxItems !== undefined && value.length > spec.maxItems) {
        errors.push(`${name} must contain at most ${spec.maxItems} items`);
      }
    }
    if (spec.enum && spec.kind === 'text' && value) {
      if (spec.enumMode === 'labels') {
        const parsed = parseLabels(value, labelIndex.get(name));
        if (parsed.unknown) errors.push(`${name} contains unsupported labels: ${parsed.unknown}`);
        else if (new Set(parsed.labels).size !== parsed.labels.length) errors.push(`${name} contains duplicate labels`);
      } else if (!spec.enum.includes(value)) errors.push(`${name} is not supported`);
    }
    if (spec.pattern && value && !new RegExp(spec.pattern).test(value)) {
      errors.push(`${name} ${spec.patternMessage ?? `must match ${spec.pattern}`}`);
    }
    if (spec.requiredWhen && applies(spec.requiredWhen, normalized) && !hasValue(spec, value)) {
      errors.push(`${name} is required${conditionSuffix(spec.requiredWhen)}`);
    }
    if (spec.forbiddenWhen && applies(spec.forbiddenWhen, normalized) && hasValue(spec, value)) {
      errors.push(`${name} must be empty${conditionSuffix(spec.forbiddenWhen)}`);
    }
  }

  function validateCard (card = {}) {
    if (!isObject(card)) return { valid: false, errors: ['must be an object'], card: normalizeCard() };
    const normalized = normalizeCard(card);
    const errors = [];
    for (const [name, value] of Object.entries(card)) {
      const spec = byName.get(name);
      if (!spec) { errors.push(`${name} is not supported`); continue; }
      if (spec.kind === 'list' && !Array.isArray(value)) errors.push(`${name} must be an array`);
      else if (spec.kind === 'list' && value.some(item => typeof item !== 'string')) {
        errors.push(`${name} must contain only strings`);
      } else if (spec.kind === 'lines' && !Array.isArray(value)) errors.push(`${name} must be an array`);
      else if (spec.kind === 'text' && typeof value !== 'string') errors.push(`${name} must be a string`);
    }
    for (const spec of specs) validateField(spec, normalized[spec.name], errors, normalized);
    return { valid: errors.length === 0, errors, card: normalized };
  }

  function validateCards (cards) {
    if (!Array.isArray(cards)) return { valid: false, errors: ['cards must be an array'], cards: [] };
    if (cards.length === 0) return { valid: true, errors: [], cards: [] };
    const results = cards.map(validateCard);
    return {
      valid: results.every(result => result.valid),
      errors: results.flatMap((result, position) => result.errors.map(error => `cards[${position}].${error}`)),
      cards: results.map(result => result.card),
    };
  }

  const fill = (template, row) => template.replace(PLACEHOLDER, (match, key) => (key in row ? row[key] : ''));
  const stripEnds = (value, chars) =>
    value.replace(new RegExp(`^[${escapeClass(chars)}]|[${escapeClass(chars)}]$`, 'g'), '');

  function renderField (entry, normalized) {
    const spec = byName.get(entry.parts[0]);
    const join = entry.join ?? '';
    if (entry.line !== undefined) {
      const rows = normalized[entry.parts[0]];
      const line = row => fill(entry.line, row);
      return (spec.sort === 'visualLength' ? arrangeByLength(rows, line) : rows).map(line).join(join);
    }
    const values = entry.parts.map(name => normalized[name]);
    if (spec.kind === 'text') {
      return values.length > 1 ? values.filter(Boolean).join(join)
        : entry.stripEnds ? stripEnds(values[0], entry.stripEnds) : values[0];
    }
    return values.length > 1 ? values.flat().filter(Boolean).join(join) : values[0].join(join);
  }

  function toAnkiFields (card) {
    const normalized = normalizeCard(card);
    return Object.fromEntries(storage.map(entry => [entry.field, renderField(entry, normalized)]));
  }

  function asPlainAnkiValue (name, value) {
    if (typeof value !== 'string') return value;
    const entry = storedBy.get(name);
    if (!entry || !JSON_START.test(value.trim())) return value;
    let parsed;
    try { parsed = JSON.parse(value); } catch { return value; }
    if (!Array.isArray(parsed)) return value;
    const spec = byName.get(entry.parts[0]);
    if (entry.line !== undefined) return renderField(entry, { [spec.name]: asRows(spec, parsed) });
    return spec.kind === 'list' ? asStrings(parsed).join(entry.join ?? '') : value;
  }

  const asPlainAnkiFields = fields => Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [name, asPlainAnkiValue(name, value)]));

  // The model reads the field schema, never the profile, so the allowed punctuation is stated where the value
  // it applies to is described as well as checked when it arrives.
  const describedValue = (spec, guidance) => {
    const allowed = punctuation[spec.script];
    return allowed === undefined ? guidance : (guidance === undefined ? `Allowed punctuation: ${allowed}` : `${guidance} Allowed punctuation: ${allowed}`);
  };

  function fieldSchema (spec) {
    const described = spec.guidance === undefined ? undefined
      : spec.guidance.replace('{values}', spec.enum ? spec.enum.join(', ') : '');
    const guidance = describedValue(spec, described);
    const description = guidance === undefined ? {} : { description: guidance };
    if (spec.kind === 'lines') {
      return {
        type: 'array', ...description,
        items: {
          type: 'object',
          properties: Object.fromEntries(spec.item.fields.map(item => {
            const row = describedValue(item, item.guidance);
            return [item.name, { type: 'string', ...(row === undefined ? {} : { description: row }) }];
          })),
          required: spec.item.fields.filter(item => item.required).map(item => item.name),
          additionalProperties: false,
        },
      };
    }
    if (spec.kind === 'list') return { type: 'array', items: { type: 'string' }, ...description };
    const enumValues = spec.enum !== undefined && spec.enumMode === 'value' ? { enum: [...spec.enum] } : {};
    return { type: 'string', ...enumValues, ...description };
  }

  const ai = specs.filter(spec => spec.ai);
  const fields = specs.map(spec => spec.name);
  const listFields = specs.filter(spec => spec.kind !== 'text').map(spec => spec.name);
  const ownerOf = name => storedBy.get(name).field;

  const defined = entries => Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));

  // A field is written out in the grammar's own order so the same profile always reads the same way, and
  // `enumMode` is left out of a field with no enum because it means nothing there — the check that reads a
  // profile refuses one, and a description that cannot be compiled back is not a description of this profile.
  const describedField = spec => Object.fromEntries(FIELD_KEYS
    .filter(key => spec[key] !== undefined && !(key === 'enumMode' && spec.enum === undefined))
    .map(key => [key, spec[key]]));

  // `of` is written back the way the profile reads it — the logical fields it holds, in write order — rather
  // than as the engine's own parsed `parts`.
  const describedStorage = entry => Object.fromEntries([
    ['field', entry.field],
    ['of', entry.parts],
    ...STORAGE_KEYS.filter(key => !['field', 'of'].includes(key) && entry[key] !== undefined)
      .map(key => [key, entry[key]]),
  ]);

  // The same profile, back in its own grammar: every default the compiler applied is written out and the
  // engine's own working parts are left behind, so this is still a profile and compiling it again yields this
  // contract. That is what lets one description of a note type serve both the file the user wrote and an agent
  // meeting it for the first time — there is no second schema here to drift from the first.
  const describe = () => Object.freeze(defined({
    profile: PROFILE_VERSION,
    noteType: profile.noteType,
    version: profile.version,
    groups: Object.keys(groups).length ? groups : undefined,
    fields: specs.map(spec => Object.freeze(describedField(spec))),
    storage: storage.map(entry => Object.freeze(describedStorage(entry))),
    collapseDuplicates: profile.collapseDuplicates,
    punctuation: Object.keys(punctuation).length ? punctuation : undefined,
  }));

  return Object.freeze({
    version: profile.version ?? '',
    noteType: profile.noteType,
    groups,
    fields,
    aiFields: ai.map(spec => spec.name),
    editorFields: specs.filter(spec => spec.editor).map(spec => spec.name),
    editorListFields: specs.filter(spec => spec.editor && spec.kind === 'list').map(spec => spec.name),
    listFields,
    linesFields: specs.filter(spec => spec.kind === 'lines').map(spec => spec.name),
    storageNames: storage.map(entry => entry.field),
    fieldMap: Object.fromEntries(storage.map(entry => [entry.parts[0], entry.field])),
    listSeparators: Object.fromEntries(storage.filter(entry => entry.parts.length === 1 && entry.join !== undefined
      && byName.get(entry.parts[0]).kind === 'list').map(entry => [entry.parts[0], entry.join])),
    spec: name => byName.get(name),
    storageFor: name => storedBy.get(name),
    describe,
    validateCard,
    validateCards,
    normalizeCard,
    orderCardFields: card => Object.fromEntries([
      ...specs.map(spec => [spec.name, normalizeCard(card)[spec.name]]),
      ...Object.keys(card).filter(field => !byName.has(field)).map(field => [field, card[field]]),
    ]),
    toAnkiFields,
    asPlainAnkiValue,
    asPlainAnkiFields,
    cardJsonSchema: Object.freeze({
      type: 'object',
      properties: Object.fromEntries(ai.map(spec => [spec.name, fieldSchema(spec)])),
      required: ai.filter(spec => spec.required).map(spec => spec.name),
      additionalProperties: false,
    }),
  });
}

module.exports = {
  arrangeByLength,
  arrangeExamples,
  allowedTagPattern,
  checkProfile,
  compileProfile,
  PROFILE_VERSION,
  visualLength,
};
