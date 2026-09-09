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
      fields: { noteTerm: note => note.term }, text: { formatCount: String, plainText: String },
    },
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
        return { note: { id: 1, term: 'kept', fields: [{ name: 'Front', value: restored ? 'before' : 'after' }] } };
      }
      const notes = restored
        ? [{ id: 1, term: 'kept' }, { id: 2, term: 'restored' }]
        : [{ id: 1, term: 'kept' }];
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
