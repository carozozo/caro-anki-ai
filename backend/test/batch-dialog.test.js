const test = require('node:test');
const assert = require('node:assert/strict');
const { createBatchDialog } = require('../../frontend/scripts/anki/batch-dialog');

// batch-dialog drives its controls through jQuery, so the fake keeps one record per element: the options a
// select was handed, the handlers an event attached, and the values written. `find('.dialog-field')` resolves
// the field wrappers the dialog hides and shows.
const createDom = () => {
  const records = new Map();
  const stateOf = target => {
    if (!records.has(target)) {
      records.set(target, { options: [], value: null, text: '', props: {}, handlers: {}, focused: false });
    }
    return records.get(target);
  };
  const apiFor = target => {
    const element = stateOf(target);
    const api = {
      0: { focus: () => { element.focused = true; } },
      html: markup => {
        element.options = [...String(markup).matchAll(/value="([^"]*)"/g)].map(match => match[1]);
        element.value = element.options[0] ?? null;
        return api;
      },
      val: value => {
        if (value === undefined) return element.value;
        element.value = value;
        return api;
      },
      on: (type, handler) => { (element.handlers[type] ||= []).push(handler); return api; },
      prop: (name, value) => {
        if (value === undefined) return element.props[name];
        element.props[name] = value;
        return api;
      },
      attr: values => { Object.assign(element.props, values); return api; },
      text: value => { element.text = value; return api; },
      data: name => element[name],
      find: () => ({ each: callback => fields.forEach((field, index) => callback(index, field)) }),
    };
    return api;
  };
  const deckField = stateOf('field:deck');
  deckField.dialogField = 'deck';
  const dueField = stateOf('field:due');
  dueField.dialogField = 'due';
  const fields = [deckField, dueField];
  return {
    $: apiFor,
    value: selector => stateOf(selector).value,
    focused: selector => stateOf(selector).focused,
    trigger: (selector, type, event = {}) => {
      stateOf(selector).handlers[type].forEach(handler => handler(event));
    },
  };
};

const optionsHtml = names => names.map(name => `<option value="${name}">${name}</option>`).join('');

const flush = () => new Promise(resolve => setImmediate(resolve));

const setup = ({ notes = [{ id: 1, deckName: 'Beta', sortField: 'first' }], deckNames = ['Alpha'] } = {}) => {
  const dom = createDom();
  const requests = [];
  const statuses = [];
  const dialog = { open: () => dom.opened.push(true), close: () => dom.closed.push(true) };
  dom.opened = [];
  dom.closed = [];
  let draft = null;
  let busy = false;
  createBatchDialog({
    $: dom.$,
    createDialog: () => dialog,
    request: async (url, { body }) => { requests.push({ url, ...JSON.parse(body) }); },
    setStatus: (message, kind) => statuses.push({ message, kind }),
    // The real view adds the deck the dialog opens on to the whitelist, so a deck it does not list still shows.
    deckOptions: current => optionsHtml([...new Set([...(current ? [current] : []), ...deckNames])]),
    draftNote: () => draft,
    selectedIds: () => new Set(notes.map(note => note.id)),
    selectedNotes: () => notes,
    isBusy: () => busy,
    setBusy: value => { busy = value; },
    refreshNoteRows: async () => {},
    renderEditorDeck: () => {},
    CaroUI: { text: { formatCount: count => String(count) } },
  });
  return {
    dom, requests, statuses,
    setDraft: value => { draft = value; },
    openDeck: () => dom.trigger('#ankiChangeDeck', 'click'),
    openDue: () => dom.trigger('#ankiSetDueDate', 'click'),
    pressEnter: selector => dom.trigger(selector, 'keydown', { key: 'Enter', preventDefault: () => {} }),
  };
};

test('the deck picker opens on the first selected note\'s deck', () => {
  const f = setup({
    notes: [{ id: 4, deckName: 'Beta' }, { id: 9, deckName: 'Gamma' }],
    deckNames: ['Alpha'],
  });
  f.openDeck();
  assert.equal(f.dom.value('#ankiBatchDeck'), 'Beta');
  assert.equal(f.dom.focused('#ankiBatchDeck'), true);
  assert.equal(f.dom.value('#ankiBatchDue'), null);
});

test('the deck picker opens on the draft\'s deck', () => {
  const f = setup({ notes: [], deckNames: ['Alpha', 'Draft'] });
  f.setDraft({ deckName: 'Draft' });
  f.openDeck();
  assert.equal(f.dom.value('#ankiBatchDeck'), 'Draft');
});

test('Enter applies the deck even when the picker never changed', async () => {
  const f = setup({ notes: [{ id: 1, deckName: 'Beta' }], deckNames: ['Alpha', 'Beta'] });
  f.openDeck();
  f.pressEnter('#ankiBatchDeck');
  await flush();
  assert.deepEqual(f.requests, [
    { url: '/api/anki/notes/batch', action: 'changeDeck', noteIds: [1], deck: 'Beta' },
  ]);
  assert.equal(f.statuses.at(-1).kind, 'ok');
  assert.equal(f.dom.closed.length, 1);
});

test('picking another deck and Enter commits once with the picked deck', async () => {
  const f = setup({ notes: [{ id: 1, deckName: 'Beta' }, { id: 2, deckName: 'Beta' }] });
  f.openDeck();
  f.dom.$('#ankiBatchDeck').val('Alpha');
  f.dom.trigger('#ankiBatchDeck', 'change', {});
  f.pressEnter('#ankiBatchDeck');
  await flush();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0], {
    url: '/api/anki/notes/batch', action: 'changeDeck', noteIds: [1, 2], deck: 'Alpha',
  });
});

test('a selected note takes priority over the editor draft and moves to _Todo immediately', async () => {
  const f = setup({ notes: [{ id: 1, deckName: 'Beta' }], deckNames: ['Beta', '_Todo'] });
  const draft = { deckName: 'Default' };
  f.setDraft(draft);
  f.openDeck();
  assert.equal(f.dom.value('#ankiBatchDeck'), 'Beta');
  f.dom.$('#ankiBatchDeck').val('_Todo');
  f.dom.trigger('#ankiBatchDeck', 'change', {});
  await flush();
  assert.deepEqual(f.requests, [
    { url: '/api/anki/notes/batch', action: 'changeDeck', noteIds: [1], deck: '_Todo' },
  ]);
  assert.equal(draft.deckName, 'Default');
});

test('Enter applies a due time', async () => {
  const f = setup();
  f.openDue();
  f.dom.$('#ankiBatchDue').val('3');
  f.pressEnter('#ankiBatchDue');
  await flush();
  assert.deepEqual(f.requests, [
    { url: '/api/anki/notes/batch', action: 'setDueDate', noteIds: [1], days: '3' },
  ]);
});

test('Enter on an empty due time writes nothing', async () => {
  const f = setup();
  f.openDue();
  f.pressEnter('#ankiBatchDue');
  await flush();
  assert.deepEqual(f.requests, []);
});

test('a draft deck move stays local and reports where the note will be created', async () => {
  const f = setup({ notes: [] });
  f.setDraft({ deckName: 'Beta' });
  f.openDeck();
  f.pressEnter('#ankiBatchDeck');
  await flush();
  assert.deepEqual(f.requests, []);
  assert.equal(f.statuses.at(-1).message, 'New note will be created in deck "Beta"');
});
