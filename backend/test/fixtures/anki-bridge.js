// A stateful stand-in for anki_bridge.py. The HTTP API tests talk to it exactly like the real bridge
// (one JSON request per line, answer marked with RESULT_PREFIX), so they need neither Anki Desktop nor
// the bundled runtime. Its state lives for the lifetime of the process, the same way the real bridge
// keeps one collection open for a whole run.
//
// The real bridge is covered by test/anki-runtime.test.js, so this file only has to honour the actions
// AnkiBrowser and AnkiExport invoke.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const collectionPath = process.argv[2];
if (collectionPath && !fs.existsSync(collectionPath)) {
  fs.mkdirSync(path.dirname(collectionPath), { recursive: true });
  fs.writeFileSync(collectionPath, 'fixture collection');
}

const RESULT_PREFIX = '__ANKI_BRIDGE_RESULT__';
const PROGRESS_PREFIX = '__ANKI_BRIDGE_PROGRESS__';
const emitProgress = update =>
  process.stdout.write(`${PROGRESS_PREFIX}${JSON.stringify(update)}\n`);
// The real bridge polls Anki on a thread while the sync runs; the fixture pushes the same shapes, and only
// when the caller asked for them, so the parser and the poll route are covered without Anki or AnkiWeb.
// Every field is Anki's own — the stages are its words and the counts are its formatted strings.
const SYNC_PROGRESS = {
  normal: [
    { kind: 'normal_sync', stage: 'Connecting', added: null, removed: null },
    { kind: 'normal_sync', stage: 'Syncing', added: '2 cards', removed: '1 note' },
    // Anki's progress state accumulates: the stage moves on but the counts it already added stay, so the
    // state a finished sync reports still carries them.
    { kind: 'normal_sync', stage: 'Finalizing', added: '2 cards', removed: '1 note' },
  ],
  full: [
    { kind: 'full_sync', transferred: 0, total: 4096 },
    { kind: 'full_sync', transferred: 4096, total: 4096 },
  ],
  media: [{ kind: 'media_sync', media: { checked: '3', added: '1', removed: '0' } }],
};
// The `English` note type mirrors the card profile the test server loads, so a card that profile stores
// lands in the fields this fake collection answers with.
const NOTE_FIELDS = require('./english-profile.json').storage.map(entry => entry.field);
const MODELS = {
  English: {
    fields: NOTE_FIELDS, options: {}, sortFieldIndex: NOTE_FIELDS.indexOf('Term'),
    templates: [{ name: 'Card 1', front: '{{Term}}', back: '{{FrontSide}}<hr id=answer>{{Meaning}}<br>{{Examples}}' }], styling: '.card {}',
  },
  Basic: {
    fields: ['Front', 'Back'], options: {}, sortFieldIndex: 0,
    templates: [{ name: 'Card 1', front: '{{Front}}', back: '{{FrontSide}}<hr id=answer>{{Back}}' }], styling: '.card {}',
  },
};
// A field's own settings are stored beside the name list the rest of this file works with, keyed by the name
// the field currently has, so a rename and a removal stay one edit in two places. Only a setting that was
// written is stored; a field nobody has configured answers with Anki's defaults.
const FIELD_DEFAULTS = {
  font: 'Arial', size: 20, rtl: false, sticky: false, description: '', collapsed: false, htmlEditor: false,
};
const fieldOptions = (model, name) => ({ ...FIELD_DEFAULTS, ...((model.options || {})[name] || {}) });
// Anki's own row keys. A table column sorts by the field it shows, so a requested field name is a sort field
// too — it just arrives in `fieldNames` rather than in this list.
const SORT_FIELDS = ['sortField', 'createdAt', 'dueAt', 'ease', 'interval', 'reps', 'lapses'];

const decks = new Set(['Default', '_Todo']);
// Study options are presets a deck names by id, so a deck that names one and the preset itself are two
// halves of the same fact. Preset 1 is the one Anki hands a deck that names none, and the decks a preset
// schedules are read back from these decks rather than stored on the preset.
const DEFAULT_PRESET_ID = 1;
const defaultPreset = () => ({
  id: DEFAULT_PRESET_ID, name: 'Default', maxTaken: 60, autoplay: true, timer: 0, replayq: true,
  waitForAudio: true, newMix: 0, buryInterdayLearning: false, stopTimerOnAnswer: false, desiredRetention: 0.9,
  new: { perDay: 20, delays: [1, 10], ints: [1, 4], initialFactor: 2500, order: 1, bury: true },
  rev: { perDay: 200, ease4: 1.3, hardFactor: 1.2, ivlFct: 1, maxIvl: 36500, bury: true },
  lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 1 },
});
const presets = new Map([[DEFAULT_PRESET_ID, defaultPreset()]]);
const presetIdByDeck = new Map([...decks].map(deck => [deck, DEFAULT_PRESET_ID]));
let presetSeq = 0;
// Anki derives a preset id from the clock, so a new one is never the number a test could hardcode.
const nextPresetId = () => Date.now() + presetSeq++;
const tagRegistry = new Set();
const notes = new Map();
let currentDeck = '_Todo';
let nextNoteId = 1000;
let nextCardId = 2000;
// Anki stamps the collection at every write and remembers the stamp of its last sync in `ls`, which is
// what the app compares to decide whether a sync is pending. The fixture tracks the writes a sync test
// makes instead of mirroring every action.
let collectionMod = 0;
let lastSyncedMod = 0;
let backupSettings = { daily: 7, weekly: 4, monthly: 12, minimumIntervalMins: 30 };
const touchCollection = () => { collectionMod = Date.now(); };
// There is no AnkiWeb to compare against, so a test that needs the server to be ahead says so up front;
// a sync reconciles the two sides, exactly like the real one.
let remoteAhead = process.env.ANKI_FIXTURE_REMOTE_AHEAD === '1';

const plain = value => String(value ?? '')
  .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().normalize('NFC');
const modelInfo = name => {
  const model = MODELS[name];
  if (!model) throw new Error(`Note type not found: ${name}`);
  return {
    name, fields: model.fields.map(field => ({ name: field, ...fieldOptions(model, field) })),
    sortFieldIndex: model.sortFieldIndex, templates: model.templates.map(template => ({ ...template })),
    styling: model.styling,
  };
};
const modelInfos = () => Object.keys(MODELS).sort().map(name => ({
  name, fields: [...MODELS[name].fields], fieldCount: MODELS[name].fields.length,
  templateCount: MODELS[name].templates.length,
}));
const modelAt = name => {
  const model = MODELS[name];
  if (!model) throw new Error(`Note type not found: ${name}`);
  return model;
};
const modelField = (model, name) => {
  if (!model.fields.includes(name)) throw new Error(`Field not found: ${name}`);
  return name;
};
const modelTemplate = (model, name) => {
  const template = model.templates.find(current => current.name === name);
  if (!template) throw new Error(`Card template not found: ${name}`);
  return template;
};
const fieldsOf = note => MODELS[note.modelName].fields;
// The note's own identity, exactly as the real bridge reads it: Anki's sort field, falling back to the first
// field that holds anything.
const noteSortField = note => {
  const fields = fieldsOf(note);
  const index = MODELS[note.modelName].sortFieldIndex;
  const value = index >= 0 && index < fields.length ? plain(note.fields[fields[index]]) : '';
  return value || fields.map(name => plain(note.fields[name])).find(Boolean) || '';
};
const noteFieldValues = (note, fieldNames = []) => Object.fromEntries(fieldNames
  .filter(name => fieldsOf(note).some(field => field.toLowerCase() === String(name).toLowerCase()))
  .map(name => [name, note.fields[fieldsOf(note)
    .find(field => field.toLowerCase() === String(name).toLowerCase())] ?? '']));
const noteData = note => ({
  noteId: note.id,
  modelName: note.modelName,
  tags: [...note.tags],
  cards: [...note.cards],
  fields: Object.fromEntries(fieldsOf(note)
    .map((name, order) => [name, { value: note.fields[name] ?? '', order }])),
});
const browserNoteInfo = (note, select = null) => {
  // A read that names no field answers with the whole shape, so the defaults are every key this builds.
  const requested = new Set(select || ['modelName', 'tags', 'fields', 'sortField', 'preview', 'deckName',
    'dueAt', 'flag', ...CARD_NUMBERS]);
  const info = { noteId: note.id };
  if (requested.has('modelName')) info.modelName = note.modelName;
  if (requested.has('tags')) info.tags = [...note.tags];
  if (['fields', 'sortField', 'preview'].some(field => requested.has(field))) {
    info.fields = Object.fromEntries(fieldsOf(note)
      .map((name, order) => [name, { value: note.fields[name] ?? '', order }]));
  }
  if (requested.has('sortField')) info.sortFieldIndex = MODELS[note.modelName].sortFieldIndex;
  if (requested.has('deckName')) info.deckName = note.deckName;
  if (requested.has('dueAt')) info.dueAt = note.dueAt;
  if (requested.has('flag')) info.flag = note.flag;
  CARD_NUMBERS.forEach(field => { if (requested.has(field)) info[field] = note[field]; });
  return info;
};
const browserNotePreview = note => {
  const model = MODELS[note.modelName];
  const [template] = model.templates;
  const front = template.front.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, field) => note.fields[field] ?? '');
  const back = template.back.replace(/\{\{FrontSide\}\}/g, front)
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, field) => note.fields[field] ?? '');
  return { noteId: note.id, modelName: note.modelName, cards: [{
    cardId: note.cards[0], templateName: template.name, front, back,
  }] };
};
const noteRow = (note, fieldNames = [], select = null) => {
  const row = {
    noteId: note.id, sortField: noteSortField(note), fieldValues: noteFieldValues(note, fieldNames),
    modelName: note.modelName,
    tags: [...note.tags], deckName: note.deckName, dueAt: note.dueAt, flag: note.flag,
    ease: note.ease, interval: note.interval, reps: note.reps, lapses: note.lapses,
  };
  if (!select) return row;
  return Object.fromEntries(['noteId', ...select]
    .filter(field => field === 'noteId' || field in row)
    .map(field => [field === 'id' ? 'noteId' : field, row[field === 'id' ? 'noteId' : field]]));
};

const emptyFields = modelName =>
  Object.fromEntries(MODELS[modelName].fields.map(name => [name, '']));
const addNote = ({ deckName, modelName, fields = {}, tags = [], options = {} }) => {
  const model = MODELS[modelName] ? modelName : 'English';
  const candidate = { modelName: model, fields: { ...emptyFields(model), ...fields } };
  if (!options.allowDuplicate) {
    const sortField = fieldsOf(candidate)[MODELS[model].sortFieldIndex];
    const duplicate = [...notes.values()].some(note => note.modelName === model
      && plain(note.fields[sortField]) === plain(candidate.fields[sortField]));
    if (duplicate) return null;
  }
  const id = nextNoteId++;
  const note = {
    id, modelName: model, fields: candidate.fields, tags: [...tags],
    deckName: deckName || currentDeck, dueAt: null, flag: 0, cards: [nextCardId++],
    // A note that has never been studied reports the deck's own new-card schedule: the default starting ease and
    // a first interval of zero, with nothing reviewed or lapsed yet.
    ease: 250, interval: 0, reps: 0, lapses: 0,
  };
  notes.set(id, note);
  decks.add(note.deckName);
  tags.forEach(tag => tagRegistry.add(tag));
  touchCollection();
  return id;
};

// Anki search is a query language; these tests only use deck:, tag:, nid:, and free text, applied as
// space-separated AND terms.
const matches = (note, query) => (query || '').trim().split(/\s+/).filter(Boolean).every(token => {
  const deck = token.match(/^deck:"?(.+?)"?$/i);
  if (deck) return note.deckName === deck[1];
  const tag = token.match(/^tag:(.+)$/i);
  if (tag) return note.tags.includes(tag[1]);
  const nid = token.match(/^nid:(\d+)$/i);
  if (nid) return note.id === Number(nid[1]);
  return plain(Object.values(note.fields).join(' ')).toLowerCase().includes(token.toLowerCase());
});
const found = query => [...notes.values()].filter(note => matches(note, query));

const CARD_NUMBERS = ['ease', 'interval', 'reps', 'lapses'];

const sortValue = (note, field, fieldNames) => field === 'sortField' ? noteSortField(note)
  : field === 'dueAt' ? note.dueAt || ''
    : CARD_NUMBERS.includes(field) ? note[field] ?? ''
      : noteFieldValues(note, [field])[field] ?? '';
// A number is a value even when it is zero, so the split is an empty slot rather than a falsy one.
const hasSortValue = key => key !== '' && key !== null && key !== undefined;
// Notes without a value for the sort field stay last in both directions, like the real bridge.
const ordered = (list, field, direction, fieldNames = []) => {
  const sign = direction === 'asc' ? 1 : -1;
  if (field === 'createdAt') return [...list].sort((left, right) => (left.id - right.id) * sign);
  const rows = list.map(note => ({ note, key: sortValue(note, field, fieldNames) }));
  const present = rows.filter(row => hasSortValue(row.key)).sort((left, right) =>
    (left.key < right.key ? -1 : left.key > right.key ? 1 : left.note.id - right.note.id) * sign);
  return [...present, ...rows.filter(row => !hasSortValue(row.key))].map(row => row.note);
};
const sortParams = (params, fieldNames = []) => ({
  field: SORT_FIELDS.includes(params.sortField) || fieldNames.includes(params.sortField)
    ? params.sortField : 'createdAt',
  direction: params.sortDirection === 'asc' ? 'asc' : 'desc',
});

const cardsFor = noteIds => {
  const missing = noteIds.find(id => !notes.has(id));
  if (missing !== undefined) return { error: 'notFound', noteId: missing };
  const selected = noteIds.map(id => notes.get(id));
  const empty = selected.find(note => !note.cards.length);
  if (empty) return { error: 'noCards', noteId: empty.id };
  return { notes: selected, cards: [...new Set(selected.flatMap(note => note.cards))] };
};
// The batch variants resolve every selected note to its cards first, so a missing or card-less note
// fails the whole action before anything is written.
const cardAction = (params, action, extra) => {
  const selected = cardsFor(params.notes);
  if (selected.error) return selected;
  actions[action]({ cards: selected.cards, ...extra });
  return { cardCount: selected.cards.length };
};

// Which decks share a preset is derived from the decks, exactly like the real bridge derives it from the
// collection, so deleting a preset has to reassign them the way Anki does.
const presetUsage = () => {
  const usage = new Map();
  presetIdByDeck.forEach((presetId, deck) => usage.set(presetId, [...(usage.get(presetId) || []), deck]));
  return usage;
};
const presetSummary = (preset, usage) => ({
  id: preset.id, name: preset.name, decks: (usage.get(preset.id) || []).sort(),
  removable: preset.id !== DEFAULT_PRESET_ID,
});
const presetDetail = preset => ({ ...preset, ...presetSummary(preset, presetUsage()) });
const presetAt = presetId => {
  const preset = presets.get(presetId);
  if (!preset) throw new Error(`Study options not found: ${presetId}`);
  return preset;
};
const presetByName = name => [...presets.values()].find(preset => preset.name === name);

const actions = {
  backupSettings: () => ({ ...backupSettings }),
  updateBackupSettings: params => {
    backupSettings = { ...params };
    return { ...backupSettings };
  },
  createBackup: () => ({ created: true }),
  checkDatabase: () => ({ healthy: true, report: 'Database rebuilt.' }),
  checkMedia: () => ({ missing: [], unused: [], report: 'No media issues found.', haveTrash: false }),
  deckNames: () => [...decks].sort(),
  createDeck: params => {
    if (decks.has(params.name)) throw new Error(`Deck already exists: ${params.name}`);
    decks.add(params.name);
    presetIdByDeck.set(params.name, DEFAULT_PRESET_ID);
    touchCollection();
    return { id: nextCardId, name: params.name };
  },
  renameDeck: params => {
    if (!decks.has(params.oldName)) throw new Error(`Deck not found: ${params.oldName}`);
    if (params.name !== params.oldName && decks.has(params.name)) throw new Error(`Deck already exists: ${params.name}`);
    const renamed = [...decks].filter(deck => deck === params.oldName || deck.startsWith(`${params.oldName}::`));
    renamed.forEach(deck => {
      const next = `${params.name}${deck.slice(params.oldName.length)}`;
      decks.delete(deck);
      decks.add(next);
      notes.forEach(note => { if (note.deckName === deck) note.deckName = next; });
      if (currentDeck === deck) currentDeck = next;
      presetIdByDeck.set(next, presetIdByDeck.get(deck));
      presetIdByDeck.delete(deck);
    });
    touchCollection();
    return { oldName: params.oldName, name: params.name };
  },
  deleteDeck: params => {
    if (params.name === 'Default') throw new Error("The 'Default' deck cannot be deleted");
    if (!decks.has(params.name)) throw new Error(`Deck not found: ${params.name}`);
    const deleted = [...decks].filter(deck => deck === params.name || deck.startsWith(`${params.name}::`));
    deleted.forEach(deck => {
      decks.delete(deck);
      presetIdByDeck.delete(deck);
      [...notes.values()].filter(note => note.deckName === deck).forEach(note => notes.delete(note.id));
      if (currentDeck === deck) currentDeck = 'Default';
    });
    touchCollection();
    return { deleted: params.name };
  },
  deckConfigs: () => {
    const usage = presetUsage();
    return [...presets.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(preset => presetSummary(preset, usage));
  },
  deckConfig: params => presetDetail(presetAt(params.configId)),
  createDeckConfig: params => {
    if (presetByName(params.name)) throw new Error(`Study options already exist: ${params.name}`);
    const base = params.cloneFrom === undefined ? presets.get(DEFAULT_PRESET_ID) : presetAt(params.cloneFrom);
    const preset = { ...structuredClone(base), id: nextPresetId(), name: params.name };
    presets.set(preset.id, preset);
    touchCollection();
    return presetDetail(preset);
  },
  updateDeckConfig: params => {
    const preset = presetAt(params.configId);
    if (params.name !== undefined) {
      const taken = presetByName(params.name);
      if (taken && taken.id !== preset.id) throw new Error(`Study options already exist: ${params.name}`);
      preset.name = params.name;
    }
    (params.settings || []).forEach(({ path, value }) => {
      const target = path.slice(0, -1).reduce((node, key) => node[key], preset);
      target[path[path.length - 1]] = value;
    });
    touchCollection();
    return presetDetail(preset);
  },
  deleteDeckConfig: params => {
    const preset = presetAt(params.configId);
    if (!presetSummary(preset, presetUsage()).removable) {
      throw new Error("The 'Default' study options cannot be deleted");
    }
    presets.delete(preset.id);
    presetIdByDeck.forEach((presetId, deck) => {
      if (presetId === preset.id) presetIdByDeck.set(deck, DEFAULT_PRESET_ID);
    });
    touchCollection();
    return { deleted: preset.name };
  },
  setDeckConfig: params => {
    if (!decks.has(params.deck)) throw new Error(`Deck not found: ${params.deck}`);
    const preset = presetAt(params.configId);
    presetIdByDeck.set(params.deck, preset.id);
    touchCollection();
    return { deck: params.deck, configId: preset.id };
  },
  modelNames: () => Object.keys(MODELS).sort(),
  modelInfos,
  modelInfo: params => modelInfo(params.modelName),
  createModel: params => {
    if (MODELS[params.name]) throw new Error(`Note type already exists: ${params.name}`);
    MODELS[params.name] = {
      fields: [...params.fields], options: {}, sortFieldIndex: 0, styling: params.styling,
      templates: params.templates.map(template => ({ ...template })),
    };
    touchCollection();
    return modelInfo(params.name);
  },
  updateModel: params => {
    const model = modelAt(params.modelName);
    if (params.name && params.name !== params.modelName) {
      if (MODELS[params.name]) throw new Error(`Note type already exists: ${params.name}`);
      delete MODELS[params.modelName];
      MODELS[params.name] = model;
      notes.forEach(note => { if (note.modelName === params.modelName) note.modelName = params.name; });
    }
    if (params.sortField) {
      const index = model.fields.indexOf(params.sortField);
      if (index < 0) throw new Error(`Field not found: ${params.sortField}`);
      model.sortFieldIndex = index;
    }
    touchCollection();
    return modelInfo(params.name || params.modelName);
  },
  deleteModel: params => {
    modelAt(params.modelName);
    delete MODELS[params.modelName];
    [...notes.values()].filter(note => note.modelName === params.modelName).forEach(note => notes.delete(note.id));
    touchCollection();
    return { deleted: params.modelName };
  },
  addModelField: params => {
    const model = modelAt(params.modelName);
    if (model.fields.includes(params.name)) throw new Error(`Field already exists: ${params.name}`);
    const index = Number.isInteger(params.index) ? Math.max(0, Math.min(params.index, model.fields.length)) : model.fields.length;
    model.fields.splice(index, 0, params.name);
    notes.forEach(note => { if (note.modelName === params.modelName) note.fields[params.name] = ''; });
    touchCollection();
    return modelInfo(params.modelName);
  },
  updateModelField: params => {
    const model = modelAt(params.modelName);
    let field = modelField(model, params.fieldName);
    let index = model.fields.indexOf(field);
    if (params.name && params.name !== field) {
      if (model.fields.includes(params.name)) throw new Error(`Field already exists: ${params.name}`);
      model.fields[index] = params.name;
      model.options[params.name] = fieldOptions(model, field);
      delete model.options[field];
      notes.forEach(note => {
        if (note.modelName !== params.modelName) return;
        note.fields[params.name] = note.fields[field];
        delete note.fields[field];
      });
      field = params.name;
    }
    if (Number.isInteger(params.index)) {
      const [moved] = model.fields.splice(index, 1);
      index = Math.max(0, Math.min(params.index, model.fields.length));
      model.fields.splice(index, 0, moved);
    }
    const settings = Object.fromEntries(
      Object.entries(params).filter(([key]) => key in FIELD_DEFAULTS));
    if (Object.keys(settings).length) model.options[field] = { ...fieldOptions(model, field), ...settings };
    touchCollection();
    return modelInfo(params.modelName);
  },
  deleteModelField: params => {
    const model = modelAt(params.modelName);
    const field = modelField(model, params.fieldName);
    if (model.fields.length === 1) throw new Error('A note type must keep at least one field');
    const index = model.fields.indexOf(field);
    model.fields.splice(index, 1);
    delete model.options[field];
    if (model.sortFieldIndex >= model.fields.length) model.sortFieldIndex = model.fields.length - 1;
    notes.forEach(note => { if (note.modelName === params.modelName) delete note.fields[field]; });
    touchCollection();
    return modelInfo(params.modelName);
  },
  addModelTemplate: params => {
    const model = modelAt(params.modelName);
    if (model.templates.some(template => template.name === params.name)) throw new Error(`Card template already exists: ${params.name}`);
    model.templates.push({ name: params.name, front: params.front, back: params.back });
    touchCollection();
    return modelInfo(params.modelName);
  },
  updateModelTemplate: params => {
    const model = modelAt(params.modelName);
    const template = modelTemplate(model, params.templateName);
    if (params.name && params.name !== template.name) {
      if (model.templates.some(current => current.name === params.name)) throw new Error(`Card template already exists: ${params.name}`);
      template.name = params.name;
    }
    if (params.front !== undefined) template.front = params.front;
    if (params.back !== undefined) template.back = params.back;
    if (params.styling !== undefined) model.styling = params.styling;
    touchCollection();
    return modelInfo(params.modelName);
  },
  deleteModelTemplate: params => {
    const model = modelAt(params.modelName);
    const template = modelTemplate(model, params.templateName);
    if (model.templates.length === 1) throw new Error('A note type must keep at least one card template');
    model.templates.splice(model.templates.indexOf(template), 1);
    touchCollection();
    return modelInfo(params.modelName);
  },
  modelFieldNames: params => {
    if (!MODELS[params.modelName]) throw new Error(`Note type not found: ${params.modelName}`);
    return MODELS[params.modelName].fields;
  },
  modelNamesAndIds: () => Object.fromEntries(
    Object.keys(MODELS).sort().map((name, index) => [name, index + 1])),
  findModelsById: params => params.modelIds
    .map((id, index) => Object.keys(MODELS)[Number(id) - 1] ?? Object.keys(MODELS)[index])
    .filter(Boolean)
    .map(name => ({ name, sortf: MODELS[name].sortFieldIndex })),
  currentDeckName: () => currentDeck,
  findNotes: params => found(params.query).map(note => note.id),
  searchNotes: params => {
    const { field, direction } = sortParams(params);
    const list = ordered(found(params.query), field, direction);
    const start = params.skip || 0;
    return {
      total: list.length,
      notes: list.slice(start, params.limit ? start + params.limit : undefined)
        .map(note => browserNoteInfo(note, params.select)),
    };
  },
  searchNoteRows: params => {
    const fieldNames = params.fieldNames || [];
    const { field, direction } = sortParams(params, fieldNames);
    const list = ordered(found(params.query), field, direction, fieldNames);
    const start = params.skip || 0;
    const page = list.slice(start, params.limit ? start + params.limit : undefined);
    return {
      total: list.length,
      notes: page.map(note => noteRow(note, fieldNames, params.select)),
      ...(params.includeIds ? { noteIds: list.map(note => note.id) } : {}),
      timing: { searchMs: 0, notesMs: 0, cardsMs: 0, sortMs: 0 },
    };
  },
  browserNoteInfo: params => (notes.has(params.noteId) ? browserNoteInfo(notes.get(params.noteId), params.select) : null),
  browserNotePreview: params => (notes.has(params.noteId) ? browserNotePreview(notes.get(params.noteId)) : null),
  notesInfo: params => params.notes.filter(id => notes.has(id)).map(id => noteData(notes.get(id))),
  cardsInfo: params => params.cards.map(cardId => {
    const note = [...notes.values()].find(item => item.cards.includes(cardId));
    return { cardId, deckName: note?.deckName ?? null, dueAt: note?.dueAt ?? null, flag: note?.flag ?? 0 };
  }),
  getTags: () => [...tagRegistry].sort(),
  addTags: params => {
    params.notes.forEach(id => {
      const note = notes.get(id);
      if (!note) return;
      note.tags = [...new Set([...note.tags, ...params.tags])];
      params.tags.forEach(tag => tagRegistry.add(tag));
    });
    return null;
  },
  removeTags: params => {
    params.notes.forEach(id => {
      const note = notes.get(id);
      if (note) note.tags = note.tags.filter(tag => !params.tags.includes(tag));
    });
    return null;
  },
  renameTag: params => {
    const matches = tag => tag === params.oldName || tag.startsWith(`${params.oldName}::`);
    const renamed = tag => matches(tag) ? `${params.name}${tag.slice(params.oldName.length)}` : tag;
    notes.forEach(note => { note.tags = [...new Set(note.tags.map(renamed))]; });
    [...tagRegistry].filter(matches).forEach(tag => {
      tagRegistry.delete(tag);
      tagRegistry.add(renamed(tag));
    });
    return null;
  },
  deleteTag: params => {
    const matches = tag => tag === params.name || tag.startsWith(`${params.name}::`);
    notes.forEach(note => { note.tags = note.tags.filter(tag => !matches(tag)); });
    [...tagRegistry].filter(matches).forEach(tag => tagRegistry.delete(tag));
    return null;
  },
  clearUnusedTags: () => {
    const used = new Set([...notes.values()].flatMap(note => note.tags));
    const unused = [...tagRegistry].filter(tag => !used.has(tag));
    unused.forEach(tag => tagRegistry.delete(tag));
    return unused.length;
  },
  changeDeck: params => {
    decks.add(params.deck);
    [...notes.values()]
      .filter(note => note.cards.some(cardId => params.cards.includes(cardId)))
      .forEach(note => { note.deckName = params.deck; });
    return null;
  },
  setDueDate: params => {
    [...notes.values()]
      .filter(note => note.cards.some(cardId => params.cards.includes(cardId)))
      .forEach(note => { note.dueAt = `due:${params.days}`; });
    return null;
  },
  setUserFlag: params => {
    [...notes.values()]
      .filter(note => note.cards.some(cardId => params.cards.includes(cardId)))
      .forEach(note => { note.flag = Number(params.flag); });
    return null;
  },
  changeDeckForNotes: params => cardAction(params, 'changeDeck', { deck: params.deck }),
  setDueDateForNotes: params => cardAction(params, 'setDueDate', { days: params.days }),
  setUserFlagForNotes: params => cardAction(params, 'setUserFlag', { flag: params.flag }),
  findAndReplace: params => {
    const missing = params.notes.find(id => !notes.has(id));
    if (missing !== undefined) return { error: 'notFound', noteId: missing };
    const source = params.regularExpression
      ? params.find
      : String(params.find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(source, `g${params.ignoreCase ? 'i' : ''}`);
    const changedNoteIds = [];
    let matchCount = 0;
    params.notes.forEach(id => {
      const note = notes.get(id);
      let changed = false;
      Object.entries(note.fields).forEach(([name, value]) => {
        if (params.field && name !== params.field) return;
        const count = String(value).match(pattern)?.length || 0;
        if (!count) return;
        note.fields[name] = params.regularExpression
          ? String(value).replace(pattern, params.replace)
          : String(value).replace(pattern, () => params.replace);
        matchCount += count;
        changed = true;
      });
      if (changed) changedNoteIds.push(id);
    });
    if (changedNoteIds.length) touchCollection();
    return { changedNoteIds, changedCount: changedNoteIds.length, matchCount };
  },
  copyNotes: params => {
    const missing = params.notes.find(id => !notes.has(id));
    if (missing !== undefined) return { error: 'notFound', noteId: missing };
    return {
      copiedIds: params.notes.map(id => addNote({
        deckName: notes.get(id).deckName, modelName: notes.get(id).modelName,
        fields: notes.get(id).fields, tags: notes.get(id).tags, options: { allowDuplicate: true },
      })),
    };
  },
  updateNoteFields: params => {
    const note = notes.get(params.note.id);
    if (!note) throw new Error(`Note ${params.note.id} was not found`);
    Object.assign(note.fields, params.note.fields);
    touchCollection();
    return null;
  },
  addNote: params => addNote(params.note),
  addNotes: params => params.notes.map(addNote),
  createBrowserNote: params => {
    const id = addNote(params);
    return id ? browserNoteInfo(notes.get(id)) : null;
  },
  deleteNotes: params => {
    params.notes.forEach(id => notes.delete(id));
    touchCollection();
    return null;
  },
  login: params => {
    if (!params.username || !params.password) throw new Error('Invalid AnkiWeb credentials');
    return { newEndpoint: null };
  },
  syncStamps: () => ({ mod: collectionMod, scm: 0, lastSync: lastSyncedMod }),
  syncCheck: params => {
    if (!params.username || !params.password) throw new Error('Invalid AnkiWeb credentials');
    return { required: remoteAhead ? 'NORMAL_SYNC' : 'NO_CHANGES', newEndpoint: null };
  },
  sync: params => {
    if (!params.username || !params.password) throw new Error('Invalid AnkiWeb credentials');
    const before = { mod: collectionMod, scm: 0, lastSync: lastSyncedMod };
    // Pushed before the answer, the way the real bridge reports while the sync is still running: the
    // collection's own states first, then the media sync Anki starts on a thread of its own afterwards.
    // Only the collection's states are what the sync reports, exactly as the real watcher decides.
    const collection = params.fullSync ? SYNC_PROGRESS.full : SYNC_PROGRESS.normal;
    if (params.progress === true) [...collection, ...SYNC_PROGRESS.media].forEach(emitProgress);
    // A merge reconciles both sides and stamps the collection with the server's own stamp, which is why it
    // is the stamp that says data moved; a sync with nothing to move never finalizes and leaves `ls` alone.
    // Anki answers NO_CHANGES either way — the whole reason the caller cannot read this off `required`.
    if (remoteAhead || collectionMod > lastSyncedMod) {
      lastSyncedMod = Math.max(collectionMod, lastSyncedMod + 1);
    }
    remoteAhead = false;
    return {
      required: { download: 'FULL_DOWNLOAD', upload: 'FULL_UPLOAD' }[params.fullSync] || 'NO_CHANGES',
      serverMessage: '',
      newEndpoint: null,
      fullSync: params.fullSync ?? null,
      // Absent unless asked for, so a caller that does not want progress sees the request and response it
      // has always seen.
      ...(params.progress === true ? { progress: collection.at(-1) ?? null } : {}),
      stamps: { before, after: { mod: collectionMod, scm: 0, lastSync: lastSyncedMod } },
    };
  },
};

const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  let result = null;
  let error = null;
  try {
    // A `null` result (a rejected duplicate, a missing note) is still a successful bridge answer, so
    // the action name decides, not the returned value.
    if (!Object.hasOwn(actions, request.action)) throw new Error(`Unsupported Anki action: ${request.action}`);
    result = actions[request.action](request.params || {});
  } catch (failure) { error = failure.message; }
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({ result, error })}\n`);
});
// The end of the request stream is the end of this process. A bridge that outlives its stdin keeps whatever
// spawned it alive, and a runner waiting on a child that never exits never finishes.
input.on('close', () => process.exit(0));
