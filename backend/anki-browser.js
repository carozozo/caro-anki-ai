const studyOptions = require('./study-options');

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 500;
const DEFAULT_TAG_LIMIT = 20;
const MAX_TAG_CHANGES = 50;
const MAX_TEMPLATE_LENGTH = 500_000;
const MAX_MODEL_FIELDS = 100;
const MAX_MODEL_TEMPLATES = 100;
const MAX_FIELD_FONT = 255;
const MAX_FIELD_SIZE = 200;
const MAX_FIELD_DESCRIPTION = 1000;
const SORT_FIELDS = ['sortField', 'createdAt', 'dueAt', 'ease', 'interval', 'reps', 'lapses'];
const MAX_FLAG = 7;
const MAX_STUDY_OPTION_NAME = 200;

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };

const toPlainText = value => value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
function asNoteId (value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail(400, 'Invalid note id');
  return id;
}

function asTags (value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(400, `${name} must be an array of tag names`);
  const tags = value.map(tag => (typeof tag === 'string' ? tag.trim() : ''));
  if (tags.some(tag => !tag)) fail(400, `${name} must contain non-empty tag names`);
  if (tags.length > MAX_TAG_CHANGES) fail(400, `${name} must contain at most ${MAX_TAG_CHANGES} tags`);
  return [...new Set(tags)];
}

function asTagName (value, name = 'tag') {
  const tag = typeof value === 'string' ? value.trim() : '';
  if (!tag) fail(400, `${name} is required`);
  return tag;
}

function asNoteIds (values) {
  if (!Array.isArray(values) || !values.length) fail(400, 'noteIds must be a non-empty array');
  return [...new Set(values.map(asNoteId))];
}

function asFindReplaceText (value, name, required = false) {
  if (typeof value !== 'string') fail(400, `${name} must be a string`);
  if (required && !value) fail(400, `${name} is required`);
  if (value.length > MAX_TEMPLATE_LENGTH) fail(400, `${name} must be at most ${MAX_TEMPLATE_LENGTH} characters`);
  return value;
}

function asFindReplaceField (value) {
  return value === undefined || value === null || value === '' ? null : asModelFieldName(value, 'field');
}

function asBoolean (value, name) {
  if (typeof value !== 'boolean') fail(400, `${name} must be a boolean`);
  return value;
}

function asDueDays (value) {
  const text = typeof value === 'string' || Number.isSafeInteger(value) ? String(value).trim() : '';
  const match = text.match(/^(\d+)(?:-(\d+))?$/);
  if (!match || (match[2] && Number(match[1]) > Number(match[2]))) {
    fail(400, 'days must be a number or ascending range such as 1 or 1-3');
  }
  return text;
}

function asModelName (value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) fail(400, 'modelName is required');
  return name;
}

function asDeckName (value, name = 'name') {
  const deckName = typeof value === 'string' ? value.trim() : '';
  if (!deckName) fail(400, `${name} is required`);
  return deckName;
}

function asStudyOptionName (value, name = 'name') {
  if (typeof value !== 'string') fail(400, `${name} must be a string`);
  const optionName = value.trim();
  if (!optionName) fail(400, `${name} is required`);
  if (optionName.length > MAX_STUDY_OPTION_NAME) {
    fail(400, `${name} must be at most ${MAX_STUDY_OPTION_NAME} characters`);
  }
  return optionName;
}

function asConfigId (value) {
  // Anki hands out millisecond-derived ids, so the number has to survive JSON as itself.
  const id = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isSafeInteger(id) || id <= 0) fail(400, 'Study options id must be a positive integer');
  return id;
}

// The bridge answers a preset the way Anki stores it: nested, in Anki's own units, and beside fields this
// app never exposes. The flat settings are what a dialog shows and what a write names, so a preset is
// translated once, here, and every route answers with the same shape.
function toStudyOption (detail) {
  return {
    id: detail.id, name: detail.name, decks: detail.decks, removable: detail.removable,
    settings: studyOptions.readOptions(detail),
  };
}

function asTemplateSource (value, name) {
  if (typeof value !== 'string') fail(400, `${name} must be a string`);
  if (value.length > MAX_TEMPLATE_LENGTH) fail(400, `${name} must be at most ${MAX_TEMPLATE_LENGTH} characters`);
  return value;
}

function asModelFieldName (value, name = 'field name') {
  const field = typeof value === 'string' ? value.trim() : '';
  if (!field) fail(400, `${name} is required`);
  if (field.length > 255) fail(400, `${name} must be at most 255 characters`);
  return field;
}

function asModelFields (value) {
  if (!Array.isArray(value) || !value.length) fail(400, 'fields must contain at least one field');
  if (value.length > MAX_MODEL_FIELDS) fail(400, `fields must contain at most ${MAX_MODEL_FIELDS} fields`);
  const fields = value.map(field => asModelFieldName(field));
  if (new Set(fields).size !== fields.length) fail(400, 'field names must be unique');
  return fields;
}

// The field names a table row is asked for. They are shown in the order they arrive, and a name more than one
// note type spells differently is read for whichever spelling the row's own note type has.
function asFieldNames (value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(400, 'fields must be an array of field names');
  if (value.length > MAX_MODEL_FIELDS) fail(400, `fields must contain at most ${MAX_MODEL_FIELDS} field names`);
  const names = value.map(name => asModelFieldName(name));
  return [...new Set(names)];
}

// A table sorts by the column it shows, so a requested field name is a sort field as much as the note's own
// identity or the two Anki timestamps are.
function isSortField (sortField, fieldNames) {
  return SORT_FIELDS.includes(sortField) || fieldNames.includes(sortField);
}

// A field's own settings are Anki's Fields screen: the font and size the note editor writes the field in, its
// direction, the hint it shows, and the two switches that decide how the editor presents it. Each is read the
// one way it may be written, so a dialog's control and a request body agree by construction.
function asFieldFont (value) {
  if (typeof value !== 'string') fail(400, 'font must be a string');
  const font = value.trim();
  if (font.length > MAX_FIELD_FONT) fail(400, `font must be at most ${MAX_FIELD_FONT} characters`);
  return font;
}

function asFieldSize (value) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FIELD_SIZE) {
    fail(400, `size must be an integer from 1 to ${MAX_FIELD_SIZE}`);
  }
  return size;
}

function asFieldDescription (value) {
  if (typeof value !== 'string') fail(400, 'description must be a string');
  const description = value.trim();
  if (description.length > MAX_FIELD_DESCRIPTION) {
    fail(400, `description must be at most ${MAX_FIELD_DESCRIPTION} characters`);
  }
  return description;
}

function asFieldToggle (value, name) {
  if (typeof value !== 'boolean') fail(400, `${name} must be a boolean`);
  return value;
}

const FIELD_SETTINGS = {
  font: asFieldFont,
  size: asFieldSize,
  description: asFieldDescription,
  rtl: value => asFieldToggle(value, 'rtl'),
  sticky: value => asFieldToggle(value, 'sticky'),
  collapsed: value => asFieldToggle(value, 'collapsed'),
  htmlEditor: value => asFieldToggle(value, 'htmlEditor'),
};

function asTemplateName (value, name = 'template name') {
  return asModelFieldName(value, name);
}

function asModelIndex (value) {
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_MODEL_FIELDS) {
    fail(400, `index must be an integer from 0 to ${MAX_MODEL_FIELDS - 1}`);
  }
  return index;
}

function asModelTemplates (value) {
  if (!Array.isArray(value) || !value.length) fail(400, 'templates must contain at least one template');
  if (value.length > MAX_MODEL_TEMPLATES) fail(400, `templates must contain at most ${MAX_MODEL_TEMPLATES} templates`);
  const templates = value.map(template => ({
    name: asTemplateName(template?.name), front: asTemplateSource(template?.front, 'front'),
    back: asTemplateSource(template?.back, 'back'),
  }));
  if (new Set(templates.map(template => template.name)).size !== templates.length) {
    fail(400, 'template names must be unique');
  }
  return templates;
}

// Anki user flags live on cards and are numbered 0 (none) through 7.
function asFlag (value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_FLAG) {
    fail(400, `flag must be an integer from 0 to ${MAX_FLAG}`);
  }
  return value;
}

// Bridge responses may omit the flag (test fixtures, older collections); read those as unflagged.
function asNoteFlag (value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_FLAG ? value : 0;
}

// Every read endpoint's own column set: what it may return, and therefore the whole of what a `select` may
// name. These are this API's names — `id`, not the bridge's `noteId` — so they live beside the mapping that
// produces them instead of in route code.
const NOTE_COLUMNS = ['id', 'createdAt', 'modelName', 'tags', 'fields', 'sortField', 'preview',
  'deckName', 'dueAt', 'flag', 'ease', 'interval', 'reps', 'lapses'];
// A table row is a narrower note shape: the field values the columns on screen asked for, keyed by the name
// the note type gives them. A search selects this path whenever it asks for no detail-only field, so the
// client chooses its representation without a second query parameter.
const NOTE_ROW_COLUMNS = ['id', 'fieldValues', 'sortField', 'modelName', 'tags', 'createdAt', 'deckName',
  'dueAt', 'flag', 'ease', 'interval', 'reps', 'lapses'];
const NOTE_SEARCH_COLUMNS = [...new Set([...NOTE_COLUMNS, ...NOTE_ROW_COLUMNS])];
// The fields whose full, per-note answer only the detail path builds: every field with its order, and the
// rendered preview. A note's identity (`sortField`) and the values of the columns on screen are rows.
const NOTE_DETAIL_COLUMNS = new Set(['fields', 'preview']);
const NOTE_TEMPLATE_COLUMNS = ['id', 'modelName', 'tags', 'fields', 'deckName'];
const DECK_COLUMNS = ['decks', 'models', 'modelFields'];
const MODEL_COLUMNS = ['name', 'fields', 'sortFieldIndex', 'templates', 'styling'];
const MODEL_SUMMARY_COLUMNS = ['name', 'fields', 'fieldCount', 'templateCount'];
const TAG_COLUMNS = ['tags', 'total'];
// A study option read answers three things: every preset, the one preset whose settings are open, and the
// field schema the dialog draws them with. A preset's settings are one indivisible shape — the dialog
// renders all of them — so this selection names the answer's parts, not a preset's own fields.
const STUDY_OPTION_COLUMNS = ['presets', 'preset', 'fields'];

// `identity` is the field that says which note or note type was read: it is always returned, because it is
// what a caller asks for that item with and what the agent's read-before-write ledger is keyed on, so no
// selection may take it away. A payload with nothing to identify (a list of deck names) names none.
function asSelect (value, columns, identity = null) {
  const requested = (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map(field => (typeof field === 'string' ? field.trim() : ''))
    .filter(Boolean);
  if (!requested.length) return null;
  if (requested.some(field => !columns.includes(field))) {
    fail(400, `select must be one of: ${columns.join(', ')}`);
  }
  return [...new Set(identity ? [identity, ...requested] : requested)];
}

// No selection is every field the endpoint already returned, so a caller that sends none is unaffected; a
// selected field the row does not carry is simply not answered.
const pickFields = (select, row) => (select
  ? Object.fromEntries(select.filter(field => field in row).map(field => [field, row[field]]))
  : row);
const pickRows = (select, rows) => (select ? rows.map(row => pickFields(select, row)) : rows);

// A scheduling value is a number the bridge derives from the note's card: a card's own interval, ease,
// review count and lapse count. A bridge that does not answer one (a test fixture, an older runtime) leaves
// that cell empty rather than the shape inconsistent.
const asSchedule = value => (Number.isFinite(value) ? value : null);

function toNote (note) {
  const fields = Object.entries(note.fields || {})
    .sort((left, right) => (left[1]?.order ?? 0) - (right[1]?.order ?? 0))
    .map(([name, field]) => ({ name, value: field?.value ?? '' }));
  const preview = fields.map(field => toPlainText(field.value)).find(Boolean) || '';
  return {
    id: note.noteId,
    createdAt: new Date(note.noteId).toISOString(),
    modelName: note.modelName,
    tags: Array.isArray(note.tags) ? note.tags : [],
    fields,
    sortField: toPlainText(fields[note.sortFieldIndex]?.value || ''),
    preview: preview.slice(0, 120),
    deckName: note.deckName,
    dueAt: note.dueAt,
    flag: asNoteFlag(note.flag),
    ease: asSchedule(note.ease),
    interval: asSchedule(note.interval),
    reps: asSchedule(note.reps),
    lapses: asSchedule(note.lapses),
  };
}

const toNoteRow = note => ({
  id: note.noteId,
  fieldValues: note.fieldValues || {},
  sortField: note.sortField || '',
  modelName: note.modelName,
  tags: Array.isArray(note.tags) ? note.tags : [],
  createdAt: new Date(note.noteId).toISOString(),
  deckName: note.deckName,
  dueAt: note.dueAt,
  flag: asNoteFlag(note.flag),
  ease: asSchedule(note.ease),
  interval: asSchedule(note.interval),
  reps: asSchedule(note.reps),
  lapses: asSchedule(note.lapses),
});

class AnkiBrowser {
  constructor ({ client, config, cardProfiles = null }) {
    Object.assign(this, { client, config, cardProfiles });
  }

  // A stored list or nested value is rendered as the plain separator-joined text Anki holds, and only the
  // profile that describes these fields can say which ones those are. With no profile for the note type
  // nothing is known about a field name, so the values pass through exactly as a name the profile does not
  // name would: the browser edits any note type, and the collection is the authority it writes back to.
  plainFields (fields, modelName = this.config.modelName) {
    const contract = this.cardProfiles?.get(modelName) ?? null;
    return contract ? contract.asPlainAnkiFields(fields) : fields;
  }

  // The collection's note types with the union of their field names: the decks and note types the quick
  // search groups by, and the candidate list a table column is chosen from. The union is what lets one table
  // show a note type the user never described, and a column whose name a given note type lacks answers
  // nothing for that note rather than hiding the row.
  async meta ({ select } = {}) {
    const [decks, infos] = await Promise.all([
      this.client.invoke('deckNames', {}),
      this.client.invoke('modelInfos', {}),
    ]);
    const models = infos.map(info => info.name);
    // Deduplicated the way Anki labels fields — case-insensitively, the first spelling winning.
    const seen = new Map();
    for (const info of infos) {
      for (const name of info.fields || []) {
        const key = name.toLowerCase();
        if (!seen.has(key)) seen.set(key, name);
      }
    }
    return pickFields(asSelect(select, DECK_COLUMNS),
      { decks, models, modelFields: [...seen.values()] });
  }

  async createDeck ({ name } = {}) {
    return this.client.invoke('createDeck', { name: asDeckName(name) });
  }

  async renameDeck (oldName, { name } = {}) {
    return this.client.invoke('renameDeck', {
      oldName: asDeckName(oldName, 'oldName'), name: asDeckName(name),
    });
  }

  async deleteDeck (name) {
    return this.client.invoke('deleteDeck', { name: asDeckName(name) });
  }

  // Study options are Anki's deck option presets: the picker draws every preset with the decks it
  // schedules, and the settings of the preset being edited arrive in the same answer, so opening the dialog
  // is one read. The schema the dialog renders those settings with is this API's own contract, which is why
  // it travels with them instead of being written twice.
  async studyOptions ({ select, presetId } = {}) {
    const answer = {
      presets: await this.client.invoke('deckConfigs', {}),
      fields: studyOptions.schema(),
    };
    if (presetId !== undefined) {
      const detail = await this.client.invoke('deckConfig', { configId: asConfigId(presetId) });
      answer.preset = toStudyOption(detail);
    }
    return pickFields(asSelect(select, STUDY_OPTION_COLUMNS), answer);
  }

  // A new preset starts from the one on screen, so the options the user just read are the ones it opens on.
  async createStudyOptions ({ name, cloneFrom } = {}) {
    const payload = { name: asStudyOptionName(name) };
    if (cloneFrom !== undefined && cloneFrom !== null) payload.cloneFrom = asConfigId(cloneFrom);
    return toStudyOption(await this.client.invoke('createDeckConfig', payload));
  }

  async updateStudyOptions (id, { name, settings } = {}) {
    const payload = { configId: asConfigId(id) };
    if (name !== undefined) payload.name = asStudyOptionName(name);
    if (settings !== undefined) payload.settings = studyOptions.patchOptions(settings);
    if (payload.name === undefined && payload.settings === undefined) {
      fail(400, 'name or settings is required');
    }
    return toStudyOption(await this.client.invoke('updateDeckConfig', payload));
  }

  async deleteStudyOptions (id) {
    return this.client.invoke('deleteDeckConfig', { configId: asConfigId(id) });
  }

  // Which preset a deck schedules with belongs to the deck: assigning one leaves every other deck that
  // shares the preset exactly as it was.
  async setDeckStudyOptions (deckName, { presetId } = {}) {
    const result = await this.client.invoke('setDeckConfig', {
      deck: asDeckName(deckName, 'deckName'), configId: asConfigId(presetId),
    });
    return { deck: result.deck, presetId: result.configId };
  }

  async models ({ select } = {}) {
    return pickRows(asSelect(select, MODEL_SUMMARY_COLUMNS, 'name'),
      await this.client.invoke('modelInfos', {}));
  }

  async model (modelName, { select } = {}) {
    const model = await this.client.invoke('modelInfo', { modelName: asModelName(modelName) });
    return pickFields(asSelect(select, MODEL_COLUMNS, 'name'), model);
  }

  async createModel ({ name, fields, templates, styling = '' } = {}) {
    return this.client.invoke('createModel', {
      name: asModelName(name), fields: asModelFields(fields), templates: asModelTemplates(templates),
      styling: asTemplateSource(styling, 'styling'),
    });
  }

  async updateModel (modelName, { name, sortField } = {}) {
    const payload = { modelName: asModelName(modelName) };
    if (name !== undefined) payload.name = asModelName(name);
    if (sortField !== undefined) payload.sortField = asModelFieldName(sortField, 'sortField');
    if (payload.name === undefined && payload.sortField === undefined) fail(400, 'name or sortField is required');
    return this.client.invoke('updateModel', payload);
  }

  async deleteModel (modelName) {
    return this.client.invoke('deleteModel', { modelName: asModelName(modelName) });
  }

  async addModelField (modelName, { name, index } = {}) {
    const payload = { modelName: asModelName(modelName), name: asModelFieldName(name) };
    if (index !== undefined) payload.index = asModelIndex(index);
    return this.client.invoke('addModelField', payload);
  }

  async updateModelField (modelName, fieldName, { name, index, ...settings } = {}) {
    const payload = { modelName: asModelName(modelName), fieldName: asModelFieldName(fieldName, 'fieldName') };
    if (name !== undefined) payload.name = asModelFieldName(name);
    if (index !== undefined) payload.index = asModelIndex(index);
    // A field's settings and its position are one write: the Fields panel saves a whole row, so the two are
    // named together instead of in a route each.
    for (const [key, read] of Object.entries(FIELD_SETTINGS)) {
      if (settings[key] !== undefined) payload[key] = read(settings[key]);
    }
    if (Object.keys(payload).length === 2) fail(400, 'a field change is required');
    return this.client.invoke('updateModelField', payload);
  }

  async deleteModelField (modelName, fieldName) {
    return this.client.invoke('deleteModelField', {
      modelName: asModelName(modelName), fieldName: asModelFieldName(fieldName, 'fieldName'),
    });
  }

  async addModelTemplate (modelName, template) {
    const { name, front, back } = asModelTemplates([template])[0];
    return this.client.invoke('addModelTemplate', { modelName: asModelName(modelName), name, front, back });
  }

  async updateModelTemplate (modelName, templateName, { name, front, back, styling } = {}) {
    const payload = { modelName: asModelName(modelName), templateName: asTemplateName(templateName, 'templateName') };
    if (name !== undefined) payload.name = asTemplateName(name);
    if (front !== undefined) payload.front = asTemplateSource(front, 'front');
    if (back !== undefined) payload.back = asTemplateSource(back, 'back');
    if (styling !== undefined) payload.styling = asTemplateSource(styling, 'styling');
    if (Object.keys(payload).length === 2) fail(400, 'a template change is required');
    return this.client.invoke('updateModelTemplate', payload);
  }

  async deleteModelTemplate (modelName, templateName) {
    return this.client.invoke('deleteModelTemplate', {
      modelName: asModelName(modelName), templateName: asTemplateName(templateName, 'templateName'),
    });
  }

  async search ({ query, skip, limit, all = false, includeIds = false, sortField = 'createdAt',
    sortDirection = 'desc', select, fields } = {}) {
    const columns = asSelect(select, NOTE_SEARCH_COLUMNS, 'id');
    if (columns && !columns.some(column => NOTE_DETAIL_COLUMNS.has(column))) {
      return this.searchRows({ query, skip, limit, includeIds, sortField, sortDirection, select: columns, fields });
    }
    const trimmed = typeof query === 'string' ? query.trim() : '';
    const effectiveQuery = trimmed;
    const requested = Number(limit);
    const max = all ? 0
      : Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;
    const offset = all ? 0 : Number.isSafeInteger(Number(skip)) && Number(skip) >= 0 ? Number(skip) : 0;
    const fieldNames = asFieldNames(fields);
    const field = isSortField(sortField, fieldNames) ? sortField : 'createdAt';
    const direction = sortDirection === 'asc' ? 'asc' : 'desc';
    const { total, notes: rawNotes } = await this.client.invoke('searchNotes', {
      query: effectiveQuery, skip: offset, limit: max, sortField: field, sortDirection: direction,
      select: columns,
    });
    const notes = rawNotes.map(toNote);
    return {
      query: effectiveQuery,
      total,
      skip: offset,
      limit: max,
      hasMore: offset + notes.length < total,
      truncated: offset + notes.length < total,
      notes: pickRows(columns, notes),
    };
  }

  async searchRows ({ query, skip, limit, includeIds = false,
    sortField = 'createdAt', sortDirection = 'desc', select, fields } = {}) {
    const trimmed = typeof query === 'string' ? query.trim() : '';
    const effectiveQuery = trimmed;
    const fieldNames = asFieldNames(fields);
    const field = isSortField(sortField, fieldNames) ? sortField : 'createdAt';
    const direction = sortDirection === 'asc' ? 'asc' : 'desc';
    const requested = Number(limit);
    const max = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : 0;
    const offset = Number.isSafeInteger(Number(skip)) && Number(skip) >= 0 ? Number(skip) : 0;
    const columns = asSelect(select, NOTE_ROW_COLUMNS, 'id');
    const { total, notes, noteIds, timing } = await this.client.invoke('searchNoteRows', {
      query: effectiveQuery, skip: offset, limit: max, includeIds,
      sortField: field, sortDirection: direction, select: columns, fieldNames,
    });
    return {
      query: effectiveQuery, total, skip: offset, limit: max,
      hasMore: max > 0 && offset + notes.length < total,
      truncated: max > 0 && offset + notes.length < total,
      notes: pickRows(columns, notes.map(toNoteRow)),
      ...(includeIds ? { noteIds } : {}), timing,
    };
  }

  async getNote (id, { select } = {}) {
    const noteId = asNoteId(id);
    const columns = asSelect(select, NOTE_COLUMNS, 'id');
    const note = await this.client.invoke('browserNoteInfo', { noteId, select: columns });
    if (!note) fail(404, 'Note not found');
    return pickFields(columns, toNote(note));
  }

  async previewNote (id) {
    const noteId = asNoteId(id);
    const preview = await this.client.invoke('browserNotePreview', { noteId });
    if (!preview) fail(404, 'Note not found');
    return preview;
  }

  async newNoteTemplate ({ modelName, select } = {}) {
    const noteType = modelName === undefined ? this.config.modelName : asModelName(modelName);
    const columns = asSelect(select, NOTE_TEMPLATE_COLUMNS, 'id');
    const [names, deckName] = await Promise.all([
      !columns || columns.includes('fields') ? this.client.invoke('modelFieldNames', { modelName: noteType }) : [],
      !columns || columns.includes('deckName') ? this.client.invoke('currentDeckName', {}) : undefined,
    ]);
    return pickFields(columns, {
      id: null, modelName: noteType, tags: [],
      fields: names.map(name => ({ name, value: '' })), deckName,
    });
  }

  async createNote ({ fields, tags, deckName, modelName } = {}) {
    const noteType = modelName === undefined ? this.config.modelName : asModelName(modelName);
    const cleanFields = this.plainFields(fields, noteType);
    const cleanTags = asTags(tags, 'tags');
    const targetDeck = typeof deckName === 'string' && deckName.trim()
      ? deckName.trim()
      : await this.client.invoke('currentDeckName', {});
    const note = await this.client.invoke('createBrowserNote', {
      deckName: targetDeck,
      modelName: noteType,
      fields: cleanFields,
      tags: cleanTags,
      options: { allowDuplicate: this.config.allowDuplicate },
    });
    if (!note) fail(422, 'The collection rejected the new note');
    return toNote(note);
  }

  // Tag names are read from the collection registry, so suggestions reuse an existing tag instead of
  // creating near-duplicates. The editor keeps its compact default while the quick search asks for all tags.
  async tags ({ query, select, limit, all: includeAll = false } = {}) {
    const available = await this.client.invoke('getTags', {});
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const requested = Number(limit);
    const max = includeAll ? 0
      : Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_TAG_LIMIT;
    const matched = available
      .filter(tag => typeof tag === 'string' && tag)
      .filter(tag => !needle || tag.toLowerCase().includes(needle))
      .sort((left, right) => left.localeCompare(right));
    return pickFields(asSelect(select, TAG_COLUMNS),
      { tags: max ? matched.slice(0, max) : matched, total: matched.length });
  }

  // Tags are collection-wide: Anki renames a tag prefix (and therefore its children) everywhere, while a
  // removal also clears that prefix from every note. The browser only hands those native operations names.
  async renameTag (oldName, { name } = {}) {
    const from = asTagName(oldName, 'oldName');
    const to = asTagName(name);
    const tags = await this.client.invoke('getTags', {});
    if (!tags.includes(from)) fail(404, 'Tag not found');
    if (from !== to) await this.client.invoke('renameTag', { oldName: from, name: to });
    return { oldName: from, name: to };
  }

  async deleteTag (name) {
    const tag = asTagName(name);
    const tags = await this.client.invoke('getTags', {});
    if (!tags.includes(tag)) fail(404, 'Tag not found');
    await this.client.invoke('deleteTag', { name: tag });
    return { deleted: tag };
  }

  async clearUnusedTags () {
    return { cleared: await this.client.invoke('clearUnusedTags', {}) };
  }

  // Anki tags are edited as an add/remove pair because the browser only tracks the note's current
  // list; the returned list is computed locally so the caller can re-render without re-reading.
  async updateNoteTags (id, { add, remove } = {}) {
    const noteId = asNoteId(id);
    const added = asTags(add, 'add');
    const removed = asTags(remove, 'remove');
    if (!added.length && !removed.length) fail(400, 'add or remove must contain at least one tag');
    if (added.some(tag => removed.includes(tag))) fail(400, 'A tag cannot be added and removed at once');
    const [note] = await this.client.invoke('notesInfo', { notes: [noteId] });
    if (!note) fail(404, 'Note not found');
    const current = Array.isArray(note.tags) ? note.tags : [];
    if (added.length) await this.client.invoke('addTags', { notes: [noteId], tags: added });
    if (removed.length) await this.client.invoke('removeTags', { notes: [noteId], tags: removed });
    const tags = [...current.filter(tag => !removed.includes(tag)), ...added.filter(tag => !current.includes(tag))];
    return { id: noteId, tags };
  }

  async batchChangeDeck ({ noteIds, deck } = {}) {
    const ids = asNoteIds(noteIds);
    const deckName = typeof deck === 'string' ? deck.trim() : '';
    if (!deckName) fail(400, 'deck must be a non-empty string');
    const result = await this.batchCardAction('changeDeckForNotes', ids, { deck: deckName });
    return { noteIds: ids, cardCount: result.cardCount, deck: deckName };
  }

  async changeNoteDueDate (id, { days } = {}) {
    const noteId = asNoteId(id);
    const value = asDueDays(days);
    const cards = await this.cardsForNotes([noteId]);
    await this.client.invoke('setDueDate', { cards, days: value });
    return { id: noteId, days: value };
  }

  async batchSetDueDate ({ noteIds, days } = {}) {
    const ids = asNoteIds(noteIds);
    const value = asDueDays(days);
    const result = await this.batchCardAction('setDueDateForNotes', ids, { days: value });
    return { noteIds: ids, cardCount: result.cardCount, days: value };
  }

  async batchSetNoteFlag ({ noteIds, flag } = {}) {
    const ids = asNoteIds(noteIds);
    const value = asFlag(flag);
    const result = await this.batchCardAction('setUserFlagForNotes', ids, { flag: value });
    return { noteIds: ids, cardCount: result.cardCount, flag: value };
  }

  async batchFindReplace ({ noteIds, query, find, replace, field, ignoreCase, regularExpression } = {}) {
    const hasExplicitIds = noteIds !== undefined;
    if (!hasExplicitIds && typeof query !== 'string') fail(400, 'query must be a string when noteIds are omitted');
    const ids = hasExplicitIds
      ? asNoteIds(noteIds)
      : [...new Set((await this.client.invoke('findNotes', { query: query.trim() })).map(asNoteId))];
    const pattern = asFindReplaceText(find, 'find', true);
    const replacement = asFindReplaceText(replace, 'replace');
    const fieldName = asFindReplaceField(field);
    const insensitive = asBoolean(ignoreCase, 'ignoreCase');
    const regex = asBoolean(regularExpression, 'regularExpression');
    if (regex) {
      try { new RegExp(pattern, insensitive ? 'i' : ''); }
      catch (error) { fail(400, `Invalid regular expression: ${error.message}`); }
    }
    if (fieldName) {
      const models = await this.client.invoke('modelInfos', {});
      if (!models.some(model => model.fields.includes(fieldName))) fail(400, 'Field not found');
    }
    if (!ids.length) return { noteIds: [], changedNoteIds: [], changedCount: 0, matchCount: 0 };
    let result;
    try {
      result = await this.client.invoke('findAndReplace', {
        notes: ids, find: pattern, replace: replacement, field: fieldName,
        ignoreCase: insensitive, regularExpression: regex,
      });
    } catch (error) {
      if (regex && error.message.startsWith('Invalid regular expression:')) fail(400, error.message);
      throw error;
    }
    if (result.error === 'notFound') fail(404, `Note ${result.noteId} was not found`);
    return { noteIds: ids, ...result };
  }

  async batchCardAction (action, noteIds, params) {
    const result = await this.client.invoke(action, { notes: noteIds, ...params });
    if (result.error === 'notFound') fail(404, `Note ${result.noteId} was not found`);
    if (result.error === 'noCards') fail(409, `Note ${result.noteId} has no cards`);
    return result;
  }

  async cardsForNotes (noteIds) {
    const notes = await this.client.invoke('notesInfo', { notes: noteIds });
    if (notes.length !== noteIds.length || notes.some(note => !note)) fail(404, 'One or more notes were not found');
    if (notes.some(note => !Array.isArray(note.cards) || !note.cards.length)) {
      fail(409, 'One or more selected notes have no cards');
    }
    const cards = [...new Set(notes.flatMap(note => Array.isArray(note.cards) ? note.cards : []))];
    return cards;
  }

  async updateNote (id, { fields } = {}) {
    const noteId = asNoteId(id);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) fail(400, 'fields must be an object');
    const entries = Object.entries(fields);
    if (!entries.length) fail(400, 'fields must not be empty');
    if (entries.some(([name, value]) => !name || typeof value !== 'string')) {
      fail(400, 'fields must map field names to string values');
    }
    // List fields are plain separator-joined text in Anki; a JSON array/object value is rendered here so
    // it can never be stored literally.
    await this.client.invoke('updateNoteFields', { note: { id: noteId, fields: this.plainFields(fields) } });
    return { id: noteId };
  }

  async copyNote (id) {
    const noteId = asNoteId(id);
    const { copiedIds } = await this.copyNotes([noteId]);
    const [copiedId] = copiedIds;
    if (!Number.isSafeInteger(copiedId) || copiedId <= 0) throw new Error('Invalid copied Anki note ID');
    return { id: copiedId };
  }

  async batchCopyNotes ({ noteIds } = {}) {
    const ids = asNoteIds(noteIds);
    const { copiedIds } = await this.copyNotes(ids);
    return { noteIds: ids, copiedIds };
  }

  async copyNotes (noteIds) {
    const result = await this.client.invoke('copyNotes', { notes: noteIds });
    if (result.error === 'notFound') fail(404, `Note ${result.noteId} was not found`);
    return result;
  }

  async deleteNote (id) {
    const noteId = asNoteId(id);
    await this.client.invoke('deleteNotes', { notes: [noteId] });
    return { id: noteId };
  }

  async batchDeleteNotes ({ noteIds } = {}) {
    const ids = asNoteIds(noteIds);
    await this.client.invoke('deleteNotes', { notes: ids });
    return { noteIds: ids };
  }

  // Anki's own global undo stack, so `undo`/`redo` here can revert or replay any collection write, not
  // only a note's own — matching what the desktop app itself does with Cmd+Z.
  async undoStatus () {
    const status = await this.client.undoStatus();
    return { canUndo: Boolean(status.undo), canRedo: Boolean(status.redo),
      undoName: status.undo, redoName: status.redo };
  }

  async undo () {
    const status = await this.client.undo();
    return { canUndo: Boolean(status.undo), canRedo: Boolean(status.redo),
      undoName: status.undo, redoName: status.redo };
  }

  async redo () {
    const status = await this.client.redo();
    return { canUndo: Boolean(status.undo), canRedo: Boolean(status.redo),
      undoName: status.undo, redoName: status.redo };
  }
}

module.exports = { AnkiBrowser, NOTE_COLUMNS, NOTE_ROW_COLUMNS, NOTE_SEARCH_COLUMNS, asSelect, pickFields };
