const test = require('node:test');
const assert = require('node:assert/strict');
// The kit takes jQuery and its timing config once, when it is loaded, so both are stood up before the require:
// the page's window with a recording timer — a real one would outlive the runner for the whole arm delay — and
// a jQuery that gives a plain element the attribute/data surface an armed button is painted through.
const fakeTimers = new Map();
let fakeTimerId = 0;
global.window = {
  CARO_AI_UI_CONFIG: {
    locale: 'en-US', timings: { systemMessageMs: 5, pendingDelayMs: 5, confirmArmMs: 3000 },
  },
  setTimeout: (callback, ms) => { fakeTimers.set(++fakeTimerId, { callback, ms }); return fakeTimerId; },
  clearTimeout: id => { fakeTimers.delete(id); },
};
const fakeButtons = new Map();
global.jQuery = element => {
  if (!fakeButtons.has(element)) {
    const button = { 0: element, attributes: {}, stored: {}, classes: new Set() };
    button.attr = (...args) => {
      if (args.length > 1) {
        button.attributes[args[0]] = args[1];
        return button;
      }
      if (typeof args[0] === 'object') {
        Object.assign(button.attributes, args[0]);
        return button;
      }
      return button.attributes[args[0]];
    };
    button.data = values => {
      if (typeof values === 'string') return button.stored[values];
      Object.assign(button.stored, values);
      return button;
    };
    button.addClass = name => { button.classes.add(name); return button; };
    button.removeClass = name => { button.classes.delete(name); return button; };
    fakeButtons.set(element, button);
  }
  return fakeButtons.get(element);
};
const {
  confirm: { armed: armedConfirm, disarm },
  entityManager,
  fields: {
    fieldValue, fillOptions, firstFieldText, noteField, noteTitle, optionsHtml, renderEntityPicker,
  },
  progress: { active, formatBytes, summary, text: progressText },
  status: { kinds, set: setSystemMessage },
  text: { escapeAttr, escapeHtml, formatCount, formatDateTime, plainText },
} = require('../../frontend/scripts/core/ui-kit');

// The kit's select helper talks to whatever jQuery was handed to it, so a three-method stand-in is enough to
// assert what a studio would actually paint: the option markup, the chosen value and the disabled state.
const fakeSelect = () => {
  const select = {
    value: '',
    markup: '',
    disabled: false,
    html (markup) { select.markup = markup; return select; },
    val (value) { select.value = value ?? ''; return select; },
    prop (name, value) { select[name] = value; return select; },
  };
  return select;
};

const fakeMessage = () => {
  const classes = new Set();
  const message = {
    0: {},
    value: '',
    removeClass (names) { names.split(' ').forEach(name => classes.delete(name)); return message; },
    addClass (name) { if (name) classes.add(name); return message; },
    text (value) { message.value = value; return message; },
  };
  return { classes, message };
};

test('escapes markup for text and attribute contexts without double-encoding', () => {
  assert.equal(escapeHtml('<b>a & b</b>'), '&lt;b&gt;a &amp; b&lt;/b&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeAttr('deck:"Idiom"'), 'deck:&quot;Idiom&quot;');
  assert.equal(escapeAttr("it's"), 'it&#39;s');
});

test('flattens card HTML into the single line used by list columns', () => {
  assert.equal(plainText('a<br>b  <b>c</b>'), 'a b c');
  assert.equal(plainText(undefined), '');
});

test('groups a count in the app locale so a large number stays readable', () => {
  assert.equal(formatCount(30000), '30,000');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(undefined), '0');
});

test('formats a stored timestamp and blanks an unusable one', () => {
  assert.equal(formatDateTime(new Date(2026, 8, 16, 7, 5).toISOString()), '2026/09/16 07:05');
  assert.equal(formatDateTime(null), '—');
  assert.equal(formatDateTime(undefined), '—');
  assert.equal(formatDateTime('not a date'), '—');
});

// A note's text is read the same way whichever of the three shapes it arrives in: the agent's
// `{ name: { value } }`, the note endpoint's `[{ name, value }]`, and a list row's own `{ name: text }`.
test('reads a named field and a note title out of every field shape', () => {
  const array = [{ name: 'Definition', value: 'guide' }, { name: 'Word', value: 'lead<br>to' }];
  const object = { Word: { value: 'lead' }, Definition: { value: 'guide' } };
  const row = { Word: 'lead<br>to', Definition: 'guide' };
  assert.equal(fieldValue(array, 'Word'), 'lead to');
  assert.equal(fieldValue(object, 'Word'), 'lead');
  assert.equal(fieldValue(row, 'Definition'), 'guide');
  // A name is matched the way Anki spells it, and one the note does not have answers nothing.
  assert.equal(fieldValue(object, 'word'), 'lead');
  assert.equal(fieldValue(object, 'Missing'), '');
  assert.equal(fieldValue(undefined, 'Word'), '');
  assert.equal(firstFieldText(object), 'lead');
  assert.equal(firstFieldText({ Word: '  ' }), '');
  // A note type's own sort field is the note's identity; without one the first field that holds text is.
  assert.equal(noteTitle({ sortField: 'lead', fields: object }), 'lead');
  assert.equal(noteTitle({ fields: object }), 'lead');
  assert.equal(noteTitle({ fields: [] }), '');
  assert.equal(noteTitle({ fieldValues: row }), 'lead to');
  assert.equal(noteField({ fieldValues: row }, 'Word'), 'lead to');
});

test('renders select options from objects or plain values with escaped content', () => {
  assert.equal(optionsHtml([{ value: 'none', label: 'Off' }, { value: 'max', label: 'Max' }]),
    '<option value="none">Off</option><option value="max">Max</option>');
  assert.equal(optionsHtml(['English', 'a<b']),
    '<option value="English">English</option><option value="a&lt;b">a&lt;b</option>');
  assert.equal(optionsHtml([]), '');
});

test('renders a select from an entity manager, selection and disabled state included', () => {
  const $select = fakeSelect();
  const manager = entityManager({
    id: model => model.name,
    list: async () => [{ name: 'English', fieldCount: 2 }, { name: 'Todo' }],
  });
  const options = { value: model => model.name, label: model => `${model.name} · ${model.fieldCount ?? 0}` };

  return manager.load('Todo').then(() => {
    renderEntityPicker($select, manager, options);
    const loaded = [$select.markup, $select.value, $select.disabled];
    // A disabled picker still shows the live list, so a caller gating on a save in flight never blanks it.
    renderEntityPicker($select, manager, { ...options, disabled: true });
    return { loaded, disabled: $select.disabled, value: $select.value, markup: $select.markup };
  }).then(result => {
    assert.deepEqual(result.loaded, [
      '<option value="English">English · 2</option><option value="Todo">Todo · 0</option>', 'Todo', false,
    ]);
    assert.deepEqual([result.disabled, result.value, result.markup], [true, 'Todo', result.loaded[0]]);
  });
});

test('an entity picker without a selection renders the empty option and a caller may override it', () => {
  const $select = fakeSelect();
  const manager = entityManager({ list: async () => ['Default', 'Word'] });
  return manager.load().then(() => {
    manager.select(null);
    renderEntityPicker($select, manager);
    const fallback = $select.value;
    renderEntityPicker($select, manager, { selectedId: 'Word' });
    return { fallback, overridden: $select.value, markup: $select.markup };
  }).then(result => {
    assert.equal(result.fallback, '');
    assert.equal(result.overridden, 'Word');
    assert.equal(result.markup, '<option value="Default">Default</option><option value="Word">Word</option>');
  });
});

test('a list is written only when the markup it would write actually changed', async () => {
  const writes = [];
  const $list = {
    0: { id: 'agentProfileSelect' },
    value: '',
    disabled: false,
    html (markup) { writes.push(markup); return $list; },
    val (value) { $list.value = value ?? ''; return $list; },
    prop (name, value) { $list[name] = value; return $list; },
  };
  const models = [{ name: 'English' }, { name: 'Todo' }];
  const manager = entityManager({ id: model => model.name, list: async () => models });
  const options = { value: model => model.name, label: model => model.name };

  await manager.load('Todo');
  renderEntityPicker($list, manager, options);
  // The second paint of the same list is not a write: the chosen value and the disabled state are applied to the
  // element that is already there, so a save that repaints an unrelated picker leaves the focus, the scroll
  // position and any open popup it holds exactly where they were.
  renderEntityPicker($list, manager, { ...options, disabled: true });
  assert.deepEqual([writes.length, $list.value, $list.disabled], [1, 'Todo', true]);

  await manager.load();
  renderEntityPicker($list, manager, options);
  assert.equal(writes.length, 1, 're-reading the same entities is not a write');

  models.push({ name: 'Idiom' });
  await manager.load();
  renderEntityPicker($list, manager, options);
  assert.deepEqual([writes.length, writes[1]], [2, '<option value="English">English</option>'
    + '<option value="Todo">Todo</option><option value="Idiom">Idiom</option>']);
  // A container that holds more than options — the visible-deck checkboxes, the instruction list — is the same
  // one way of writing: a caller gates it on the markup, which is what it compares.
  assert.equal(fillOptions($list, writes[1]), $list);
  assert.equal(writes.length, 2);
});

test('publishes the status vocabulary the CSS defines', () => {
  assert.deepEqual(kinds, ['pending', 'ok', 'warn', 'error']);
});

test('clears non-error system messages after the shared delay and leaves errors visible', async () => {
  const { message, classes } = fakeMessage();
  setSystemMessage(message, 'Saved.', 'ok');
  assert.equal(message.value, 'Saved.');
  assert.equal(classes.has('is-ok'), true);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(message.value, '');
  assert.equal(classes.has('is-ok'), false);

  setSystemMessage(message, 'Unable to save.', 'error');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(message.value, 'Unable to save.');
  assert.equal(classes.has('is-error'), true);
});

// A save that lands inside the grace period must not flash "Saving…" on its way to "Saved.", but a write that
// really is slow still has to announce itself — the two halves of the same rule.
test('holds a pending message back until its grace period elapses', async () => {
  const { message } = fakeMessage();
  const painted = [];
  const paint = message.text.bind(message);
  message.text = value => { painted.push(value); return paint(value); };

  setSystemMessage(message, 'Saving…', 'pending');
  setSystemMessage(message, 'Saved.', 'ok');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(painted, ['Saved.', ''], 'a result cancels the wait it would have interrupted');

  painted.length = 0;
  setSystemMessage(message, 'Saving…', 'pending');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(painted.includes('Saving…'), 'a wait longer than the grace period is shown');

  // A persistent status is state rather than a wait, so the connection pill is never held back.
  painted.length = 0;
  setSystemMessage(message, 'Checking connection', 'pending', { persistent: true });
  assert.deepEqual(painted, ['Checking connection']);
});

// A line that describes something permanent — the browser's status says which notes are on screen — hands that
// sentence back when a transient one clears, instead of being left blank for the rest of the session.
test('hands a line back to its baseline when a transient message clears', async () => {
  const { message } = fakeMessage();
  const restore = () => setSystemMessage(message, '128 notes', 'ok', { persistent: true });

  setSystemMessage(message, '128 notes', 'ok', { persistent: true });
  setSystemMessage(message, 'Deleted 2 notes', 'ok', { onClear: restore });
  assert.equal(message.value, 'Deleted 2 notes');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(message.value, '128 notes');

  // An error is not a message that clears on its own, so the baseline is not restored behind the user's back.
  setSystemMessage(message, 'Saved note 5', 'ok', { onClear: restore });
  setSystemMessage(message, 'Anki refused the write.', 'error');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(message.value, 'Anki refused the write.');
});

test('formats a transfer size in the largest unit that keeps it readable', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(10240), '10 KB');
  assert.equal(formatBytes(3145728), '3.0 MB');
  assert.equal(formatBytes(2147483648), '2.0 GB');
  // Anki reports no size until it has transferred something, and an unusable one still has to render.
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(undefined), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
});

// Anki names the normal-sync stage and formats its own counts, so both are shown as received: the app
// must not translate them or invent a unit, which is why these tests pass its strings through verbatim.
test('shows a sync in progress with the stage and counts Anki reports', () => {
  assert.equal(progressText({ kind: 'normal_sync', stage: 'Syncing', added: '2 cards', removed: '1 note' }),
    'Updating collection\nSyncing · 2 cards · 1 note');
  // A stage with nothing counted yet still names what Anki is doing.
  assert.equal(progressText({ kind: 'normal_sync', stage: 'Connecting', added: null, removed: null }),
    'Updating collection\nConnecting');
  assert.equal(progressText(null), 'Syncing with AnkiWeb…');
});

test('shows a full sync as a transfer against the total only it knows', () => {
  assert.equal(progressText({ kind: 'full_sync', transferred: 3145728, total: 8388608 }, 'upload'),
    'Uploading to AnkiWeb — 3.0 MB of 8.0 MB');
  assert.equal(progressText({ kind: 'full_sync', transferred: 2048, total: 0 }, 'download'),
    'Downloading from AnkiWeb — 2.0 KB');
  // The direction words the button asked for win, because Anki reports the stage without one.
  assert.equal(progressText({ kind: 'full_sync', transferred: 1024, total: 4096 }),
    'Downloading from AnkiWeb — 1.0 KB of 4.0 KB');
});

test('shows media counts Anki reports, and omits the ones it has not reported', () => {
  assert.equal(progressText({ kind: 'media_sync', media: { checked: '42', added: '3', removed: '1' } }),
    'Syncing media — 42 checked, 3 uploaded, 1 downloaded');
  assert.equal(progressText({ kind: 'media_sync', media: { checked: '42', added: null, removed: null } }),
    'Syncing media — 42 checked');
  assert.equal(progressText({ kind: 'media_sync', media: {} }), 'Syncing media…');
});

test('appends what a finished sync reported, and nothing when it reported nothing', () => {
  assert.equal(summary({ kind: 'full_sync', transferred: 3145728, total: 8388608 }), ' — 3.0 MB transferred');
  assert.equal(summary({ kind: 'media_sync', media: { checked: '42', added: '3', removed: '1' } }),
    ' — 42 checked, 3 uploaded, 1 downloaded');
  // Anki's normal-sync counts are DATABASE ROWS, not the notes that changed, so a finished merge reports
  // its outcome alone: the counts stay in the running pill, where they describe work still in flight.
  assert.equal(summary({ kind: 'normal_sync', stage: 'Finalizing', added: 'Removed: ⁨2⁩↑ ⁨0⁩↓', removed: null }),
    '');
  // A size Anki never reported is not invented.
  assert.equal(summary({ kind: 'full_sync', transferred: 0, total: 0 }), '');
  assert.equal(summary(null), '');
});

// The blocking transfer window opens on this answer, so it has to mean "data is moving" and nothing else:
// Anki reports a stage as soon as it talks to AnkiWeb, a sync that finds nothing to move included.
test('reports a transfer only once Anki counts something moving', () => {
  assert.equal(active(null), false);
  assert.equal(active({ kind: 'normal_sync', stage: 'Connecting', added: null, removed: null }), false);
  assert.equal(active({ kind: 'normal_sync', stage: 'Syncing', added: 'Added/modified: ⁨0⁩↑ ⁨0⁩↓',
    removed: 'Removed: ⁨0⁩↑ ⁨0⁩↓' }), false);
  // A download shows up in the same strings' other direction.
  assert.equal(active({ kind: 'normal_sync', stage: 'Syncing', added: 'Added/modified: ⁨0⁩↑ ⁨3⁩↓' }), true);
  assert.equal(active({ kind: 'normal_sync', stage: 'Syncing', added: 'Added/modified: ⁨3⁩↑ ⁨0⁩↓' }), true);
  assert.equal(active({ kind: 'full_sync', transferred: 0, total: 4096 }), false);
  assert.equal(active({ kind: 'full_sync', transferred: 2048, total: 4096 }), true);
  assert.equal(active({ kind: 'media_sync', media: { checked: '42' } }), true);
  assert.equal(active({ kind: 'media_sync', media: {} }), false);
});

// The pill while a sync runs and the message when it ends may disagree, because only a quantity a reader
// can act on survives the finish. A media sync has one, so both views must join it the same way; a normal
// sync's row counts are dropped rather than repeated.
test('keeps the quantities a reader can act on and drops the counts of work in flight', () => {
  const media = { kind: 'media_sync', media: { checked: '42', added: '3', removed: '1' } };
  const [, running = ''] = progressText(media).split(' — ');
  assert.equal(summary(media), ` — ${running}`);
  const normal = { kind: 'normal_sync', stage: 'Syncing', added: 'Added/modified: ⁨3⁩↑ ⁨0⁩↓', removed: null };
  assert.match(progressText(normal), /Added\/modified/);
  assert.equal(summary(normal), '');
});

// entityManager is the shared "pick one, create one, rename it, delete it" state machine behind Note Type
// Studio, Deck Studio, and the Collection Profile picker. It holds no DOM, so these tests exercise it with
// a plain in-memory backing list, the same way a caller's own list/create/rename/remove would.
const backedManager = (initial, overrides = {}) => {
  let rows = initial.map(row => ({ ...row }));
  const manager = entityManager({
    list: async () => rows.map(row => ({ ...row })),
    create: async name => {
      const entity = { id: name, name };
      rows.push(entity);
      return entity;
    },
    rename: async (id, name) => {
      const row = rows.find(current => current.id === id);
      row.name = name;
      return { ...row };
    },
    remove: async id => {
      rows = rows.filter(current => current.id !== id);
      return { deleted: id };
    },
    ...overrides,
  });
  return manager;
};

test('loads a list and selects the first entity when nothing was selected before', async () => {
  const manager = backedManager([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
  await manager.load();
  assert.equal(manager.selectedId(), 'a');
  assert.deepEqual(manager.selected(), { id: 'a', name: 'Alpha' });
  assert.equal(manager.items().length, 2);
});

test('keeps the current selection across a reload when it still exists', async () => {
  const manager = backedManager([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
  await manager.load();
  manager.select('b');
  await manager.load();
  assert.equal(manager.selectedId(), 'b');
});

test('falls back to the first item once the selected entity is gone', async () => {
  const manager = backedManager([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
  await manager.load();
  manager.select('missing');
  await manager.load();
  assert.equal(manager.selectedId(), 'a');
});

test('create reloads the list and selects the entity it just created', async () => {
  const manager = backedManager([{ id: 'a', name: 'Alpha' }]);
  await manager.load();
  await manager.create('Gamma');
  assert.equal(manager.selectedId(), 'Gamma');
  assert.equal(manager.items().length, 2);
});

test('rename reloads the list and keeps the renamed entity selected under its new id', async () => {
  const manager = backedManager([{ id: 'a', name: 'Alpha' }]);
  await manager.load();
  await manager.rename('a', 'Alpha2');
  assert.equal(manager.selected().name, 'Alpha2');
});

test('remove reloads the list and falls back to the first remaining entity', async () => {
  const manager = backedManager([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
  await manager.load();
  manager.select('a');
  await manager.remove('a');
  assert.equal(manager.items().length, 1);
  assert.equal(manager.selectedId(), 'b');
});

test('canRename/canDelete evaluate the caller\'s own guard against the selected entity, or null when empty', () => {
  const manager = backedManager([], {
    canRename: entity => Boolean(entity) && entity.name !== 'Default',
    canDelete: entity => Boolean(entity) && entity.name !== 'Default',
  });
  assert.equal(manager.canRename(), false);
  assert.equal(manager.canDelete(), false);
});

test('canRename/canDelete respect a guard such as a protected default entity', async () => {
  const manager = backedManager([{ id: 'Default', name: 'Default' }, { id: 'x', name: 'English' }], {
    canRename: entity => entity?.name !== 'Default',
    canDelete: entity => entity?.name !== 'Default',
  });
  await manager.load();
  assert.equal(manager.canRename(), false);
  assert.equal(manager.canDelete(), false);
  manager.select('x');
  assert.equal(manager.canRename(), true);
  assert.equal(manager.canDelete(), true);
});

test('id/labelOf default to reading name, but a caller can key by a separate id field', async () => {
  const manager = entityManager({
    list: async () => [{ id: 1, name: 'Profile A' }, { id: 2, name: 'Profile B' }],
    create: async () => null, rename: async () => null, remove: async () => null,
  });
  await manager.load();
  assert.equal(manager.selectedId(), 1);
  assert.equal(manager.selected().name, 'Profile A');
});

// The two-step confirm's own state: which button is armed, what its second press does, and — for an action
// whose target can move between the two clicks — that the press it gets is about the target it armed for.
const press = (confirm, element, armLabel) => confirm.handle({ currentTarget: element }, armLabel);

const fakeButton = (label) => {
  const element = { id: label };
  const $button = global.jQuery(element);
  $button.attr({ 'aria-label': label, title: label });
  return { element, $button };
};

// Every case starts from a disarmed control and an empty timer registry, because both are shared by the kit
// and by the fake window this file loads it with.
const resetConfirm = () => { disarm(); fakeTimers.clear(); };

test('arming paints the danger state with the arm label and its own timer restores the button', () => {
  resetConfirm();
  let confirmed = 0;
  const confirm = armedConfirm(() => { confirmed++; });
  const { element, $button } = fakeButton('Delete selected notes');

  assert.equal(press(confirm, element, 'Click again to delete 2 selected notes'), 'armed');
  assert.deepEqual([...$button.classes], ['button-danger']);
  assert.equal($button.attr('aria-label'), 'Click again to delete 2 selected notes');
  assert.equal($button.attr('title'), 'Click again to delete 2 selected notes');
  assert.deepEqual([...fakeTimers.values()].map(timer => timer.ms), [3000]);

  [...fakeTimers.values()].forEach(timer => timer.callback());
  assert.deepEqual([...$button.classes], []);
  assert.equal($button.attr('title'), 'Delete selected notes');
  assert.equal(press(confirm, element), 'armed', 'a press after the arm expired only arms again');
  assert.equal(confirmed, 0);
  resetConfirm();
});

test('only the same button\'s second press confirms, and it clears the armed state', () => {
  resetConfirm();
  const confirmed = [];
  const confirm = armedConfirm(() => confirmed.push('run'));
  const { element, $button } = fakeButton('Delete selected notes');

  assert.equal(press(confirm, element, 'Click again to delete 1 selected note'), 'armed');
  assert.equal(press(confirm, element), 'confirmed');
  assert.deepEqual(confirmed, ['run']);
  assert.deepEqual([...$button.classes], []);
  assert.equal($button.attr('title'), 'Delete selected notes');

  // A press on another control is its own first press, never a confirmation of this one.
  const other = fakeButton('Delete deck');
  assert.equal(press(confirm, element, 'Click again to delete 1 selected note'), 'armed');
  assert.equal(press(confirm, other.element, 'Click again to delete "Deck A"'), 'armed');
  assert.deepEqual([...$button.classes], []);
  assert.equal(confirmed.length, 1);
  resetConfirm();
});

test('a locked action re-arms instead of destroying a target that moved under the arm', () => {
  resetConfirm();
  const destroyed = [];
  let target = 'note 1';
  const confirm = armedConfirm(() => destroyed.push(target), { lock: () => target });
  const { element, $button } = fakeButton('Delete selected notes');

  assert.equal(press(confirm, element, 'Click again to delete 1 selected note'), 'armed');
  target = 'note 2';
  assert.equal(press(confirm, element, 'Click again to delete 2 selected notes'), 'retargeted');
  assert.deepEqual(destroyed, [], 'the moved target is not destroyed');
  assert.deepEqual([...$button.classes], ['button-danger'], 'the press re-armed against the new target');
  assert.equal($button.attr('aria-label'), 'Click again to delete 2 selected notes');

  assert.equal(press(confirm, element, 'Click again to delete 2 selected notes'), 'confirmed');
  assert.deepEqual(destroyed, ['note 2'], 'the confirmation lands only on the target it was armed for');
  resetConfirm();
});
