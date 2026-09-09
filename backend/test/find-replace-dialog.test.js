const test = require('node:test');
const assert = require('node:assert/strict');
const { createFindReplaceDialog, createFindReplaceHistory } = require('../../frontend/scripts/anki/find-replace-dialog');

const createStorage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
};

const createDom = () => {
  const records = new Map();
  const record = selector => records.get(selector) || records.set(selector, {
    handlers: {}, html: '', props: {}, value: '', focused: false,
  }).get(selector);
  const $ = selector => {
    const state = record(selector);
    const api = {
      html: value => { state.html = value; return api; },
      on: (type, handler) => { (state.handlers[type] ||= []).push(handler); return api; },
      prop: (name, value) => {
        if (typeof name === 'object') Object.assign(state.props, name);
        else if (value === undefined) return state.props[name];
        else state.props[name] = value;
        return api;
      },
      text: value => { state.text = value; return api; },
      trigger: type => {
        if (type === 'focus') state.focused = true;
        state.handlers[type]?.forEach(handler => handler({ preventDefault: () => {} }));
        return api;
      },
      val: value => {
        if (value === undefined) return state.value;
        state.value = value;
        return api;
      },
    };
    return api;
  };
  return { $, record };
};

const config = {
  storageKeys: { ankiFindReplaceHistory: 'find-replace-history' },
  ankiBrowser: { findReplaceHistoryLimit: 12 },
};

test('find and replace histories retain at most 12 recent unique values', () => {
  const history = createFindReplaceHistory({ storage: createStorage(), key: 'history', limit: 12 });
  for (let index = 1; index <= 14; index++) history.remember('find', `find-${index}`);
  history.remember('find', 'find-5');
  history.remember('replace', 'replacement');

  assert.deepEqual(history.values('find'), [
    'find-5', 'find-14', 'find-13', 'find-12', 'find-11', 'find-10',
    'find-9', 'find-8', 'find-7', 'find-6', 'find-4', 'find-3',
  ]);
  assert.deepEqual(history.values('replace'), ['replacement']);
});

test('opening Find and Replace clears inputs while retaining their suggestions', () => {
  const storage = createStorage();
  storage.setItem('find-replace-history', JSON.stringify({ find: ['needle'], replace: ['replacement'] }));
  const dom = createDom();
  const dialog = { open: () => {}, close: () => {} };
  const findReplace = createFindReplaceDialog({
    $: dom.$, config, storage, createDialog: () => dialog, request: async () => ({}), setStatus: () => {},
    fieldNames: () => [], selectedIds: () => new Set(), currentQuery: () => '', isBusy: () => false,
    setBusy: () => {}, saveActiveNote: async () => ({ saved: true }), reloadNotes: async () => {},
    refreshUndoStatus: () => {},
    CaroUI: {
      text: { escapeAttr: value => value, formatCount: count => String(count) },
      fields: { optionsHtml: () => '' },
    },
  });
  dom.record('#ankiFindReplaceFind').value = 'stale find';
  dom.record('#ankiFindReplaceWith').value = 'stale replacement';

  findReplace.open();

  assert.equal(dom.record('#ankiFindReplaceFind').value, '');
  assert.equal(dom.record('#ankiFindReplaceWith').value, '');
  assert.match(dom.record('#ankiFindReplaceFindHistory').html, /needle/);
  assert.match(dom.record('#ankiFindReplaceWithHistory').html, /replacement/);
});
