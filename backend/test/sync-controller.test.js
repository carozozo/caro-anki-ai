const test = require('node:test');
const assert = require('node:assert/strict');
const { createSyncController, syncButtonState } = require('../../frontend/scripts/anki/sync-controller');

const fakeJQuery = events => {
  const nodes = new Map();
  const node = selector => {
    if (nodes.has(selector)) return nodes.get(selector);
    const next = {
      selector,
      addClass: name => (events.push(['addClass', selector, name]), next),
      attr: () => next,
      on: () => next,
      prop: () => next,
      removeAttr: () => next,
      removeClass: name => (events.push(['removeClass', selector, name]), next),
      text: () => next,
      toggleClass: () => next,
      trigger: (name, args) => (events.push(['trigger', selector, name, args]), next),
      val: () => next,
    };
    nodes.set(selector, next);
    return next;
  };
  return selector => node(selector === global.document ? 'document' : selector);
};

const restoreGlobal = (name, value) => {
  if (value === undefined) delete global[name];
  else global[name] = value;
};

test('a forced full sync marks the sync button as an error', () => {
  for (const required of ['FULL_SYNC', 'FULL_UPLOAD', 'FULL_DOWNLOAD']) {
    assert.deepEqual(syncButtonState({ needsSync: true, required }), {
      needsSync: true,
      fullSyncRequired: true,
    });
  }
});

test('ordinary pending and clean sync states do not mark the button as an error', () => {
  assert.equal(syncButtonState({ needsSync: true, required: 'NORMAL_SYNC' }).fullSyncRequired, false);
  assert.deepEqual(syncButtonState({ needsSync: false }), {
    needsSync: false,
    fullSyncRequired: false,
  });
});

test('a completed merge closes its result before releasing the button and refreshing the browser', async t => {
  const original = Object.fromEntries(['document', 'fetch', 'window'].map(name => [name, global[name]]));
  t.after(() => Object.entries(original).forEach(([name, value]) => restoreGlobal(name, value)));
  const events = [];
  global.document = {};
  global.fetch = async () => ({ json: async () => ({ ok: true, progress: { running: false } }) });
  global.window = { clearInterval, setInterval, setTimeout };
  const $ = fakeJQuery(events);
  const dialogs = new Map();
  const controller = createSyncController({
    $,
    config: { syncProgressClosing: 'is-closing', timings: { requestTimeoutMs: 100, syncFadeMs: 0, syncLingerMs: 0,
      syncProgressMs: 100 } },
    CaroUI: {
      confirm: { armed: () => ({ handle: () => {} }) },
      dialogs: { create: ({ selector, onClose = () => {} }) => {
        let open = false;
        const dialog = {
          close: () => { events.push(['close', selector]); open = false; onClose(); },
          isOpen: () => open,
          open: () => { events.push(['open', selector]); open = true; },
        };
        dialogs.set(selector, dialog);
        return dialog;
      } },
      progress: { active: () => true, summary: () => '', text: () => 'Syncing with AnkiWeb…' },
      status: { set: ($element, text) => events.push(['message', $element.selector, text]) },
    },
    request: async route => route === '/api/anki/sync'
      ? { sync: { merged: true, required: 'NO_CHANGES' } } : {},
    armDeadline: () => ({ arm: () => {}, clear: () => {}, signal: undefined }),
    CONNECTED_STATUS: 'Connected',
    SYNC_REMINDER: { hint: 'Sync with AnkiWeb' },
    state: { busy: false, pending: false },
    connectionStatus: { needsSync: true, required: 'NORMAL_SYNC' },
    setStatus: () => {},
    renderStatus: () => {},
    getAnkiSettingsState: () => ({ account: { loggedIn: true } }),
    loadAnkiSettings: async () => {},
    NoteShortcuts: { aria: () => '', display: () => '', find: () => ({}) },
  });

  assert.equal(await controller.runAnkiSync(), true);
  const closed = events.findIndex(event => event[0] === 'close' && event[1] === '#ankiSyncProgressDialog');
  const released = events.findIndex(event => event[0] === 'removeClass' && event[2] === 'is-syncing');
  const refreshed = events.findIndex(event => event[0] === 'trigger' && event[2] === 'anki-sync-finished');
  assert.ok(events.findIndex(event => event[0] === 'message' && event[2].includes('changes were merged')) < closed);
  assert.ok(closed < released && released < refreshed);
  assert.deepEqual(events[refreshed][3], [{ merged: true, required: 'NO_CHANGES' }]);
  assert.equal(dialogs.get('#ankiSyncProgressDialog').isOpen(), false);
});
