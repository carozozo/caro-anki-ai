((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroAnkiBrowser = api;
})(globalThis, () => {
  const initAnkiBrowser = ({
    $,
    config,
    desktop,
    CaroUI,
    NoteListState,
    NoteSelection,
    NoteShortcuts,
    request,
    state,
    readBrowserView,
    writeBrowserView,
    armedConfirm,
    createDialog,
    isDialogOpen,
    loadAnkiSettings,
    getAnkiSettingsState,
    getAnkiModelChoices,
    setAnkiModelChoices,
    CardDocument,
    CardPreview,
    BatchDialog,
    FindReplaceDialog,
    NoteListInput,
    NoteEditor,
    NoteBrowserState,
    BrowserPanels,
    QueryHistory,
    QuickSearch,
    NoteListColumns,
    NoteListView,
    StudyOptionsDialog,
    NoteTypeStudio,
    DeckStudio,
    TagStudio,
  }) => {
    const { autoGrow, fillOptions, optionsHtml } = CaroUI.fields;
    const { chipButton, icon } = CaroUI.icons;
    const { set: setSystemMessage } = CaroUI.status;
    const { escapeAttr, escapeHtml, formatCount, plainText } = CaroUI.text;
    const $panel = $('#ankiBrowserPannel');
    const $chat = $('#ankiChat');
    if (!$panel.length) return;
    const $list = $('#ankiNoteList');
    const $editor = $('#ankiNoteEditor');
    const $browserStatus = $('#ankiBrowserStatus');
    const $query = $('#ankiQuery');
    const $searchPrefix = $('#ankiSearchPrefix');
    const { NOTE_LIST_FIELDS, NOTE_ROW_READ_FIELDS } = NoteListColumns;
    // The browser's status line has a baseline: how many notes the current query matched. A list status is
    // written for keeps — `keep` — so it never times out, and every transient sentence (a save, a copy, a
    // deletion, a studio's answer) hands the line back to that baseline once it clears, which leaves the line
    // describing the list while nothing is happening. A failure outranks it, because an error stays until its
    // owner replaces it.
    let browserStatusBaseline = '';
    const restoreBrowserStatus = () => setSystemMessage(
      $browserStatus, browserStatusBaseline, browserStatusBaseline ? 'ok' : '', { persistent: true });
    const setBrowserStatus = (text, kind = '', { keep = false } = {}) => {
      if (keep) browserStatusBaseline = text;
      return setSystemMessage($browserStatus, text, kind, { persistent: keep, onClear: restoreBrowserStatus });
    };
    const queryHistory = QueryHistory.createQueryHistory({ $, $panel, config, CaroUI });
    const quickSearchPrefixes = QuickSearch.searchPrefixes(config.ankiBrowser.quickSearchGroups);
    const prefixOptions = fieldNames => {
      return optionsHtml([{ value: '', label: 'None' }])
        + `<optgroup label="Quick search">${optionsHtml(quickSearchPrefixes)}</optgroup>`
        + `<optgroup label="Card fields">${optionsHtml(fieldNames)}</optgroup>`;
    };
    const renderSearchPrefixes = fieldNames => {
      const selected = $searchPrefix.val();
      fillOptions($searchPrefix, prefixOptions(fieldNames));
      $searchPrefix.val(['', ...quickSearchPrefixes, ...fieldNames].includes(selected) ? selected : '');
    };
    let searchPrefixRequest = 0;
    renderSearchPrefixes([]);
    $searchPrefix.on('change', event => {
      const prefix = event.currentTarget.value;
      if (!prefix) return;
      const query = `${prefix}:`;
      queryHistory.close();
      $query.val(query).trigger('focus')[0].setSelectionRange(query.length, query.length);
    });

    BrowserPanels.createBrowserPanels({ $, config, $panel, NoteShortcuts });

    // A field column is named in the rows' own request, so the set of field columns is part of what the loaded
    // rows carry: a column added after the rows were read has no values in them, and repainting cannot invent
    // any. Every read records the field columns it asked for, and the funnel below refreshes the rows when the
    // table's current layout is not the one they were read with.
    let loadedFieldSignature = null;
    const fieldSignature = names => [...names].sort().join('\u0000');
    const refreshRowsForFields = () => {
      const signature = fieldSignature(columns.fieldNames());
      // An empty list has nothing to re-read, and a read in flight is superseded rather than left alone: its
      // request named the older columns, so its result is the one that would strand the new column.
      if (signature === loadedFieldSignature || !noteBrowser.notes().length) return;
      loadedFieldSignature = signature;
      noteBrowser.loadNotes(noteBrowser.currentQuery(), noteBrowser.activeId(), true, { allowBusy: true });
    };
    // The table and the Settings panel draw the same layout, so this one funnel repaints both: every writer of the
    // column list goes through it, and the panel redraws from the same answer the table just rendered.
    const columns = NoteListColumns.createNoteListColumns({
      $, $list, config, setStatus: setBrowserStatus,
      onOrderChange: () => {
        noteListView.renderBrowserList();
        $(document).trigger('anki-list-fields-changed');
        refreshRowsForFields();
      },
    });

    // The browser's state — the loaded notes and their index, the selection, the note the editor holds, the
    // query, and the view it persists — is one module, created first because every control below reads it. It
    // reads the list and the editor back through thunks, because those are wired from that same state.
    const noteBrowser = NoteBrowserState.createNoteBrowserState({
      $, $list, $query, config, CaroUI, NoteListState, NoteSelection, request, queryHistory,
      readBrowserView, writeBrowserView, NOTE_LIST_FIELDS, NOTE_ROW_READ_FIELDS, setBrowserStatus,
      // The rows a read answers carry exactly these field values, so the signature is taken from the request
      // that is being built — the read and the columns it serves are recorded together.
      noteFieldNames: () => {
        const names = columns.fieldNames();
        loadedFieldSignature = fieldSignature(names);
        return names;
      },
      renderBrowserList: () => noteListView.renderBrowserList(),
      renderBrowserRow: (note, index) => noteListView.renderBrowserRow(note, index),
      renderSelectedCount: () => noteListView.renderSelectedCount(),
      renderVisibleRows: force => noteListView.renderVisibleRows(force),
      collapsedGroups: () => quickSearch.collapsedGroups(),
      quickSearchGroupOrder: () => quickSearch.groupOrder(),
      refreshQuickSearchTags: () => quickSearch.refreshTags(),
      editor: () => noteEditor,
    });

    const batchDialog = BatchDialog.createBatchDialog({
      $, createDialog, request, CaroUI, setStatus: setBrowserStatus,
      draftNote: () => noteBrowser.draftNote(),
      selectedIds: () => noteBrowser.selectedIds(), selectedNotes: () => noteBrowser.selectedNotes(),
      isBusy: () => noteBrowser.isBusy(),
      setBusy: value => noteBrowser.setBusy(value),
      deckOptions: current => noteListView.deckOptions(current),
      refreshNoteRows: ids => noteBrowser.refreshNoteRows(ids),
      renderEditorDeck: () => renderEditorDeck(),
    });

    const noteListView = NoteListView.createNoteListView({
      $, $list, config, CaroUI, NoteListState, columns, desktop,
      noteTitle: note => noteBrowser.noteTitle(note), noteIndexOf: id => noteBrowser.noteIndexOf(id),
      loadVisibleNotePages: range => noteBrowser.loadVisibleNotePages(range),
      persistView: () => noteBrowser.persistView(),
      closeBatchDialog: () => batchDialog.close(),
      visibleDeckNames: () => QuickSearch.visibleDeckNames(deckStudio.deckNames(), getAnkiSettingsState()),
      notes: () => noteBrowser.notes(), selectedIds: () => noteBrowser.selectedIds(),
      activeId: () => noteBrowser.activeId(), draftNote: () => noteBrowser.draftNote(),
      editorOpen: () => noteBrowser.isEditorOpen(), busy: () => noteBrowser.isBusy(),
      sortField: () => noteBrowser.sortField(), sortDirection: () => noteBrowser.sortDirection(),
      canUndo: () => noteBrowser.canUndo(), canRedo: () => noteBrowser.canRedo(),
    });
    const {
      renderBatchActions, renderBrowserList, renderBrowserRow, renderSelectedCount,
      renderSortIndicators, renderVisibleRows, visibleNoteRange,
    } = noteListView;

    const quickSearch = QuickSearch.createQuickSearch({
      $, config, CaroUI, restoredGroups: noteBrowser.savedView.collapsedGroups,
      restoredGroupOrder: noteBrowser.savedView.quickSearchGroupOrder,
      deckNames: () => deckStudio.deckNames(), modelNames: getAnkiModelChoices, getSettings: getAnkiSettingsState,
      request, loadNotes: query => noteBrowser.loadNotes(query), persistView: () => noteBrowser.persistView(),
    });

    // Study Options is Anki's own deck options: a preset any number of decks can name, drawn from the schema
    // the API answers with. `StudyOptionsDialog` owns that dialog, its form and the preset list the deck
    // studio reads back.
    const studyOptions = StudyOptionsDialog.createStudyOptions({
      $, request, CaroUI, createDialog, armedConfirm, setStatus: setBrowserStatus,
      // Deck Studio draws the same preset list, so it redraws itself from the answer just written.
      onPresetsChanged: () => deckStudio.refresh(),
    });
    const deckStudio = DeckStudio.createDeckStudio({
      $, request, CaroUI, createDialog, armedConfirm, setStatus: setBrowserStatus, studyOptions,
      loadSettings: loadAnkiSettings, getSettings: getAnkiSettingsState,
      // The card fields a search can be prefixed with are the collection's own, and they arrive with the decks:
      // one read names every note type's fields, so the menu needs no second request.
      onDecksLoaded: async (_deckNames, models, modelFields) => {
        await setAnkiModelChoices(models);
        // The table's field columns and the search prefix menu read the same union of note type fields, so the
        // header is chosen before the list is painted from it. Handing the fields over also redraws the Settings
        // panel's roster through the column funnel, so it offers the collection's own fields from then on.
        columns.setModelFields(modelFields);
        renderSearchPrefixes([...modelFields].sort((a, b) => a.localeCompare(b)));
        renderBrowserList();
        quickSearch.render();
        quickSearch.refreshTags();
        renderBatchActions();
      },
      onDecksError: message => quickSearch.renderError(message),
    });

    const tagStudio = TagStudio.createTagStudio({
      $, request, CaroUI, createDialog, armedConfirm,
      onTagsChanged: async () => {
        await Promise.all([quickSearch.refreshTags(), noteBrowser.loadNotes(noteBrowser.currentQuery())]);
      },
    });

    const noteTypeStudio = NoteTypeStudio.createNoteTypeStudio({
      $, request, CaroUI, createDialog, armedConfirm, setStatus: setBrowserStatus,
      getSettings: getAnkiSettingsState,
      selectedModelName: () => noteBrowser.selectedNotes()[0]?.modelName,
      refreshSidebars: async () => {
        await deckStudio.load();
        await setAnkiModelChoices((await request('/api/anki/decks')).models);
      },
    });

    // Previous/Next and First/Last differ only in the index they aim at, and the preview cursor lands through
    // the same landing, because the card on screen is just another way to arrive at a note.
    const navigateSelectedNote = async offset => {
      if (noteBrowser.isBusy() || noteBrowser.selectedIds().size > 1) return;
      const id = noteBrowser.selectedIds().values().next().value;
      if (id === undefined) {
        if (!noteBrowser.isEditorOpen()) {
          noteListInput.moveNoteSelection(null, offset < 0 ? 'ArrowUp' : 'ArrowDown', false);
        }
        return;
      }
      await noteBrowser.landOnIndex(noteBrowser.noteIndexOf(id) + offset);
    };

    // An unselected list enters at the edge being jumped to; a draft owns the editor, so nothing moves.
    const navigateSelectedNoteEdge = async edge => {
      if (noteBrowser.isBusy() || noteBrowser.selectedIds().size > 1) return;
      if (!noteBrowser.selectedIds().size && noteBrowser.isEditorOpen()) return;
      await noteBrowser.landOnIndex(edge < 0 ? 0 : noteBrowser.notes().length - 1);
    };

    // The selection travels as the composer chip's `selectionNoteIds`, never as raw IDs typed into the
    // composer: the textarea stays free for what the user actually wants to say.
    const sendSelectedNotesToAi = async () => {
      const selected = noteBrowser.selectedNotes();
      if (state.busy || state.pending || !selected.length) return;
      if (noteBrowser.isEditorOpen() && !(await saveActiveNote({ silent: true })).saved) return;
      $panel.trigger('show-chat');
      noteBrowser.publishChatSelection();
      $('#messageInput').trigger('focus');
    };

    $('#ankiSelectedSearch').on('click', () => noteBrowser.searchSelectedNotes());
    $('#ankiSelectedAi').on('click', sendSelectedNotesToAi);
    $('#ankiSelectedCopy').on('click', () => noteBrowser.copySelectedNotes());
    // The armed delete is locked to the notes it was armed for: the lock is the selection's ids, so a second
    // click that lands after the user selected something else re-arms for that selection instead of deleting
    // it, and nothing is ever deleted that was not the selection the arm label named.
    const selectedDeleteConfirm = armedConfirm(async () => noteBrowser.deleteSelectedNotes(),
      { lock: () => [...noteBrowser.selectedIds()].sort((a, b) => a - b).join(',') });

    $('#ankiSelectedDelete').on('click', event => {
      const count = noteBrowser.selectedIds().size;
      if (noteBrowser.isBusy() || !count) return;
      const outcome = selectedDeleteConfirm.handle(event,
        `Click again to delete ${formatCount(count)} selected note${count === 1 ? '' : 's'}`);
      if (outcome === 'retargeted') setBrowserStatus('Selection changed; press delete again to confirm', 'warn');
    });

    // Every gesture the list answers — a click, a modifier click, an arrow, a flag shortcut, ⌘A, Esc, a sort
    // header — is wired in one module. It is created here, where the first of those listeners used to be bound,
    // because the order the document keydowns are registered in is what decides which one sees a key.
    const noteListInput = NoteListInput.createNoteListInput({
      $, $list, $editor, $panel, $chat,
      notes: () => noteBrowser.notes(),
      selectedIds: () => noteBrowser.selectedIds(),
      activeId: () => noteBrowser.activeId(),
      isEditorOpen: () => noteBrowser.isEditorOpen(),
      isBusy: () => noteBrowser.isBusy(),
      isDialogOpen,
      currentSelection: () => noteBrowser.currentSelection(),
      applySelection: selection => noteBrowser.applySelection(selection),
      selectedNotes: () => noteBrowser.selectedNotes(),
      noteIndexOf: id => noteBrowser.noteIndexOf(id),
      selectionMemoryIndex: () => noteBrowser.selectionMemoryIndex(),
      visibleNoteRange,
      publishChatSelection: selection => noteBrowser.publishChatSelection(selection),
      runBatch: (action, values, text) => batchDialog.run(action, values, text),
      openNoteEditor: id => noteEditor.openNoteEditor(id), renderSortIndicators,
      reloadList: () => noteBrowser.loadNotes(noteBrowser.currentQuery()),
      getSort: () => ({ field: noteBrowser.sortField(), direction: noteBrowser.sortDirection() }),
      setSort: next => noteBrowser.setSort(next),
      columns,
      cardPreview: () => cardPreview,
      toggleTargetField: () => noteEditor.toggleTargetField(),
      NoteSelection, NoteListState, NoteShortcuts,
    });

    // The card preview walks the loaded list order and lands the page on the card it shows, so it reads the
    // list, the selection and the one landing the list navigates with — all three live.
    const cardPreview = CardPreview.createCardPreview({
      $, config, request, CaroUI, createDialog, CardDocument,
      notes: () => noteBrowser.notes(),
      selectedIds: () => noteBrowser.selectedIds(),
      landOnIndex: index => noteBrowser.landOnIndex(index),
      isBusy: () => noteBrowser.isBusy(),
    });

    let findReplaceDialog;
    $('#ankiUndo').on('click', () => noteBrowser.undoLastAction());
    $('#ankiRedo').on('click', () => noteBrowser.redoLastAction());
    $('#ankiFirstNote').on('click', () => navigateSelectedNoteEdge(-1));
    $('#ankiPreviousNote').on('click', () => navigateSelectedNote(-1));
    $('#ankiNextNote').on('click', () => navigateSelectedNote(1));
    $('#ankiLastNote').on('click', () => navigateSelectedNoteEdge(1));
    $('#ankiNewNote').on('click', () => createNote());
    $('#ankiStudyOptions').on('click', () => studyOptions.open());
    $('#ankiEditNoteType').on('click', () => noteTypeStudio.open());
    $('#ankiManageDecks').on('click', () => deckStudio.open());
    $('#ankiManageTags').on('click', () => tagStudio.open());
    $('#ankiFindReplace').on('click', () => findReplaceDialog?.open());
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    // The four list-navigation shortcuts label their preview twin too: same chord, two targets, and the button
    // under the press says which of the two the dialog moves.
    const renderShortcutLabels = () => NoteShortcuts.definitions
      .filter(shortcut => shortcut.scope === 'browser' && shortcut.selector)
      .forEach(shortcut => {
        [[shortcut.selector, shortcut.label], [shortcut.previewSelector, shortcut.previewLabel]]
          .filter(([selector]) => selector)
          .forEach(([selector, label]) => $(selector).attr({
            'aria-keyshortcuts': NoteShortcuts.aria(shortcut),
            'aria-label': label,
            title: `${label} (${NoteShortcuts.display(shortcut, isMac)})`,
          }));
      });
    renderShortcutLabels();
    $(document).on('anki-shortcuts-changed', renderShortcutLabels);

    const noteEditor = NoteEditor.createNoteEditor({
      $, $editor, $list, request, CardDocument, NoteSelection, NoteShortcuts,
      autoGrow, chipButton, icon, optionsHtml, escapeAttr, escapeHtml, plainText,
      activeNote: () => noteBrowser.activeNote(), noteIndexOf: id => noteBrowser.noteIndexOf(id),
      rememberSelection: id => noteBrowser.rememberSelection(id),
      notes: () => noteBrowser.notes(), fetchNote: (id, select) => noteBrowser.fetchNote(id, select),
      noteFields: note => noteBrowser.noteFields(note), notePreview: fields => noteBrowser.notePreview(fields),
      rebuildNoteIndex: () => noteBrowser.rebuildNoteIndex(),
      trackLoadedNote: id => noteBrowser.trackLoadedNote(id),
      clearLoadedPages: () => noteBrowser.clearLoadedPages(),
      bumpNoteTotal: () => noteBrowser.bumpNoteTotal(),
      applySelection: selection => noteBrowser.applySelection(selection),
      renderSelection: focusId => noteBrowser.renderSelection(focusId),
      renderBrowserList, renderBrowserRow, renderSelectedCount, renderVisibleRows,
      loadVisibleNotePages: range => noteBrowser.loadVisibleNotePages(range),
      setBrowserStatus, setNoteListStatus: () => noteBrowser.setNoteListStatus(),
      isBusy: () => noteBrowser.isBusy(), setBusy: value => noteBrowser.setBusy(value),
      isEditorOpen: () => noteBrowser.isEditorOpen(), setEditorOpen: value => noteBrowser.setEditorOpen(value),
      editorBase: () => noteBrowser.editorBase(), setEditorBase: value => noteBrowser.setEditorBase(value),
      setDraftNote: note => noteBrowser.setDraftNote(note),
      getActiveId: () => noteBrowser.activeId(), setActiveId: id => noteBrowser.setActiveId(id),
      getModelChoices: getAnkiModelChoices, setModelChoices: setAnkiModelChoices,
      refreshQuickSearchTags: () => quickSearch.refreshTags(),
      refreshUndoStatus: () => noteBrowser.refreshUndoStatus(),
    });
    const {
      renderBrowserEditor, renderEditorDeck, saveActiveNote, openNoteEditor,
      createNote, toggleTargetField, flushEditorOnUnload,
    } = noteEditor;

    findReplaceDialog = FindReplaceDialog.createFindReplaceDialog({
      $, CaroUI, config, createDialog, request, setStatus: setBrowserStatus,
      fieldNames: () => columns.modelFieldNames(),
      selectedIds: () => noteBrowser.selectedIds(), currentQuery: () => noteBrowser.currentQuery(),
      isBusy: () => noteBrowser.isBusy(), setBusy: value => noteBrowser.setBusy(value),
      saveActiveNote: () => saveActiveNote({ silent: true }),
      reloadNotes: () => noteBrowser.loadNotes(noteBrowser.currentQuery(), noteBrowser.activeId(), true, {
        allowBusy: true, skipSave: true,
      }),
      refreshUndoStatus: () => noteBrowser.refreshUndoStatus(),
    });

    $('#ankiSearchForm').on('submit', event => {
      event.preventDefault();
      queryHistory.close();
      noteBrowser.loadNotes($query.val());
    });

    const refreshAfterAgent = async (_event, operations) => {
      if (noteBrowser.isBusy()) return window.setTimeout(() => refreshAfterAgent(null, operations), 100);
      quickSearch.refreshTags();
      const ids = NoteListState.updatedNoteIds(operations)
        .filter(id => noteBrowser.noteIndexOf(id) >= 0);
      await noteBrowser.refreshNoteRows(ids);
      if (noteBrowser.isEditorOpen() && ids.includes(noteBrowser.activeId())) renderBrowserEditor();
    };
    $(document).on('anki-agent-finished', refreshAfterAgent);

    $(document).on('anki-settings-changed', () => {
      deckStudio.load();
      if (!$query.val().trim()) noteBrowser.loadNotes('', noteBrowser.activeId(), true);
    });
    // A full sync replaces the collection, but a normal merge leaves note IDs stable. Keep the browser's
    // current editor and selection for that merge when their notes still exist.
    $(document).on('anki-sync-finished', async (_event, sync) => {
      await deckStudio.load();
      const preserve = !sync.fullSync;
      noteBrowser.loadNotes(noteBrowser.currentQuery(), preserve ? noteBrowser.activeId() : null, preserve);
    });
    $('#messageList').on('click', '.locate-note', async event => {
      const id = Number($(event.currentTarget).data('note-id'));
      $query.val(`nid:${id}`);
      await noteBrowser.loadNotes(`nid:${id}`, id);
      if (noteBrowser.activeId() === id) openNoteEditor(id);
    });
    // Last resort for a reload or a close: the view record is flushed here, and the editor writes whatever it
    // still holds. Both answer with a keepalive request, because the page is already going away.
    window.addEventListener('pagehide', () => {
      noteBrowser.flushView();
      flushEditorOnUnload();
    });

    $panel.trigger('open-browser-panels');
    deckStudio.load();
    noteBrowser.restoreView().catch(error => setBrowserStatus(error.message, 'error'));
    noteBrowser.refreshUndoStatus();

    // The note list's column controller is handed back so the Settings dialog can offer the collection's own
    // field names as its List Fields candidate list and write the user's choice through this one writer.
    return { noteListColumns: columns };
  };

  return { initAnkiBrowser };
});
