const test = require('node:test');
const assert = require('node:assert/strict');
const { createNoteBrowserState } = require('../../frontend/scripts/anki/note-browser-state');

const view = {
  query: '', sortField: 'createdAt', sortDirection: 'desc', scrollTop: 0,
  selectedIds: [], activeId: null, editorOpen: false,
};

const list = () => ({
  find: () => ({ each: () => {}, replaceWith: () => {} }),
  innerHeight: () => 0,
  scrollTop: () => 0,
});

test('reloads the note list and active editor note after undo and redo', async () => {
  let restored = false;
  let saves = 0;
  const renderedValues = [];
  let state;
  state = createNoteBrowserState({
    $: () => ({}), $list: list(), $query: { val: () => '' },
    config: {
      ankiBrowser: { notePreviewLength: 80, noteList: { pageSize: 100, rowHeight: 42 } }, timings: {},
    },
    CaroUI: {
      fields: { noteTitle: note => note.sortField || '' }, text: { formatCount: String, plainText: String },
    },
    noteFieldNames: () => [],
    NoteListState: { selectedNotesInOrder: () => [] },
    NoteSelection: {
      none: () => ({ ids: [], anchorId: null }), containedIn: () => ({ ids: [], anchorId: null }),
    },
    request: async (url, options = {}) => {
      if (url === '/api/anki/undo-status') return { status: { undoName: 'Remove Note' } };
      if (url === '/api/anki/undo' && options.method === 'POST') {
        restored = true;
        return { status: { redoName: 'Remove Note' } };
      }
      if (url === '/api/anki/redo' && options.method === 'POST') {
        restored = false;
        return { status: { undoName: 'Remove Note' } };
      }
      if (url === '/api/anki/notes/1') {
        return { note: { id: 1, sortField: 'kept', fields: [{ name: 'Front', value: restored ? 'before' : 'after' }] } };
      }
      const notes = restored
        ? [{ id: 1, sortField: 'kept' }, { id: 2, sortField: 'restored' }]
        : [{ id: 1, sortField: 'kept' }];
      return { notes, noteIds: notes.map(note => note.id), total: notes.length };
    },
    queryHistory: { remember: () => {} }, readBrowserView: () => view, writeBrowserView: () => {},
    NOTE_LIST_FIELDS: ['id'], NOTE_ROW_READ_FIELDS: ['id'], renderBrowserList: () => {},
    renderBrowserRow: () => '', renderSelectedCount: () => {}, renderVisibleRows: () => ({ first: 0, end: 0 }),
    setBrowserStatus: () => {}, collapsedGroups: () => [], quickSearchGroupOrder: () => [],
    refreshQuickSearchTags: () => {},
    editor: () => ({
      saveActiveNote: async () => { saves++; },
      renderBrowserEditor: () => {
        if (state.isEditorOpen()) renderedValues.push(state.activeNote().fields.map(field => field.value));
      },
    }),
  });

  await state.loadNotes('');
  state.notes()[0].fields = [{ name: 'Front', value: 'after' }];
  state.setActiveId(1);
  state.setEditorOpen(true);
  await state.refreshUndoStatus();
  await state.undoLastAction();

  assert.deepEqual(state.notes().map(note => note.id), [1, 2]);
  assert.deepEqual(renderedValues, [['before']]);
  await state.redoLastAction();
  assert.deepEqual(state.notes().map(note => note.id), [1]);
  assert.deepEqual(renderedValues, [['before'], ['after']]);
  assert.equal(saves, 1, 'a history reload must not create a new collection write');
});

test('searches every selected note by nid', () => {
  let query = '';
  const state = createNoteBrowserState({
    $: () => ({}), $list: list(), $query: { val: value => { if (value !== undefined) query = value; return query; } },
    config: {
      ankiBrowser: { notePreviewLength: 80, noteList: { pageSize: 100, rowHeight: 42 } }, timings: {},
    },
    CaroUI: {
      fields: { noteTitle: note => note.sortField || '' }, text: { formatCount: String, plainText: String },
    },
    noteFieldNames: () => [],
    NoteListState: { selectedNotesInOrder: (notes, ids) => notes.filter(note => ids.has(note.id)) },
    NoteSelection: {}, request: async () => ({ notes: [], noteIds: [], total: 0 }),
    queryHistory: { remember: () => {} }, readBrowserView: () => view, writeBrowserView: () => {},
    NOTE_LIST_FIELDS: ['id'], NOTE_ROW_READ_FIELDS: ['id'], renderBrowserList: () => {},
    renderBrowserRow: () => '', renderSelectedCount: () => {}, renderVisibleRows: () => ({ first: 0, end: 0 }),
    setBrowserStatus: () => {}, collapsedGroups: () => [], quickSearchGroupOrder: () => [],
    refreshQuickSearchTags: () => {},
    editor: () => ({ saveActiveNote: async () => ({ saved: true }), renderBrowserEditor: () => {} }),
  });

  state.notes().push(
    { id: 101, sortField: 'alpha', fields: [{ name: 'Front', value: 'alpha' }] },
    { id: 205, sortField: 'beta', fields: [{ name: 'Front', value: 'beta' }] },
  );
  state.rebuildNoteIndex();
  state.applySelection({ ids: [101], anchorId: 101 });
  state.searchSelectedNotes();

  assert.equal(query, 'nid:101');

  state.applySelection({ ids: [101, 205], anchorId: 101 });
  state.searchSelectedNotes();

  assert.equal(query, 'nid:101 OR nid:205');
});
