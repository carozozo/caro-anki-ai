((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteBrowserState = api;
})(globalThis, () => {
  // Everything the browser remembers between two renders: the loaded notes and their index, the selection, the
  // note the editor holds, the query, and the paging bookkeeping — plus the one place each of those is written.
  // The page's wiring reads them through this module and never keeps a copy of its own.
  const createNoteBrowserState = ({
    $, $list, $query, config, CaroUI, NoteListState, NoteSelection, request, queryHistory,
    readBrowserView, writeBrowserView, NOTE_LIST_FIELDS, NOTE_ROW_READ_FIELDS, noteFieldNames,
    renderBrowserList, renderBrowserRow, renderSelectedCount, renderVisibleRows,
    setBrowserStatus, collapsedGroups, quickSearchGroupOrder, refreshQuickSearchTags, editor,
  }) => {
    const { noteTitle: titleOf } = CaroUI.fields;
    const { formatCount, plainText } = CaroUI.text;
    const { notePreviewLength, noteList } = config.ankiBrowser;
    const { pageSize } = noteList;

    // The view the page was left in, read once: the query and sort are the first request it makes and the
    // rest is applied when that request lands. Everything below then persists the LIVE state again.
    const savedView = readBrowserView();
    let sortField = savedView.sortField;
    let sortDirection = savedView.sortDirection;
    let notes = [];
    let noteTotal = 0;
    let activeId = null;
    let draftNote = null;
    let editorOpen = false;
    // The note as the editor last rendered it: the base of the save merge, so an untouched field is never
    // written and a field changed elsewhere keeps its newer value.
    let editorBase = {};
    let busy = false;
    let currentQuery = '';
    let noteListRevision = 0;
    let noteIndex = new Map();
    let loadedNoteIds = new Set();
    let loadedPages = new Set();
    const notePageRequests = new Map();
    let selectionAnchorId = null;
    // A bare ArrowUp/ArrowDown with nothing selected re-enters the list beside the last selection, so the row
    // of that selection is remembered per list (a new query starts a new list and forgets it).
    let selectionMemory = null;
    const selectedIds = new Set();
    // Anki's own global undo stack, so these track whatever it would revert or replay next — not only a
    // note's own writes.
    let undoName = null;
    let redoName = null;

    // How many notes the query matched is the only thing this line says, and it is the line's baseline —
    // written for keeps, and restored whenever a transient sentence clears (see `setBrowserStatus` in
    // anki-browser.js). The counts of work in flight, the query echo and the timings are diagnostics, so they
    // live in the console line below instead of competing with the one number the user asked for.
    const setNoteListStatus = () => setBrowserStatus(`${formatCount(noteTotal)} note${
      noteTotal === 1 ? '' : 's'}`, 'ok', { keep: true });

    // The row title is the note's own sort field — whatever its note type calls it — falling back to the
    // first non-empty field so a note whose sort field is empty is still identifiable.
    const notePreview = fields => fields
      .map(field => plainText(field.value)).find(Boolean)?.slice(0, notePreviewLength) || '';
    const noteTitle = note => titleOf(note) || (note.fields ? notePreview(note.fields) : '') || `note ${note.id}`;
    const noteFields = note => Object.fromEntries(note.fields.map(field => [field.name, field.value]));
    const noteIndexOf = id => noteIndex.get(id) ?? -1;
    const rebuildNoteIndex = () => { noteIndex = new Map(notes.map((note, index) => [note.id, index])); };
    const rememberSelection = id => {
      const index = noteIndexOf(id);
      if (index >= 0) selectionMemory = { id, index };
    };
    // A remembered note that leaves the list (deleted, or filtered out by a reload) keeps its row number, and
    // `selectionMemoryIndex` clamps it to the nearest row the list still has.
    const selectionMemoryIndex = () => {
      if (!selectionMemory) return null;
      const index = noteIndexOf(selectionMemory.id);
      return index >= 0 ? index : selectionMemory.index;
    };
    const activeNote = () => draftNote || notes[noteIndexOf(activeId)] || null;
    const selectedNotes = () => NoteListState.selectedNotesInOrder(notes, selectedIds);
    // The browser selection is NOT pushed into Chat on every click: the composer chip is armed only when
    // the user sends the selection with the Send-to-AI action, and it then keeps that snapshot until it is
    // cleared, so browsing further never silently retargets a pending request.
    const publishChatSelection = selection => $(document).trigger('anki-selection-change',
      [selection ?? selectedNotes().map(note => ({ id: note.id, title: noteTitle(note) }))]);

    // Conflict detection needs the note as the server holds it NOW, because the editor's own snapshot can be
    // older than an agent write that landed while it was open.
    const fetchNote = async (id, select = '') => {
      try {
        return (await request(`/api/anki/notes/${id}${select ? `?select=${select}` : ''}`)).note;
      } catch { return null; }
    };
    const refreshNoteRows = async ids => {
      const visibleIds = ids.filter(id => noteIndexOf(id) >= 0);
      if (!visibleIds.length) return;
      const updates = await Promise.all(
        visibleIds.map(id => fetchNote(id, NOTE_ROW_READ_FIELDS.join(','))));
      notes = NoteListState.mergeUpdatedNotes(notes, updates);
      updates.filter(Boolean).forEach(note => loadedNoteIds.add(note.id));
      visibleIds.forEach(id => {
        const index = noteIndexOf(id);
        if (index < 0) return;
        $list.find(`.anki-note-row[data-note-id="${id}"]`).replaceWith(renderBrowserRow(notes[index], index));
      });
    };

    const currentSelection = () => ({ ids: [...selectedIds], anchorId: selectionAnchorId });

    // The one place the selection is written. Every gesture resolves through `NoteSelection` into the same
    // shape and lands here, so "what the page does with a selection" — replace the ids, move the anchor,
    // re-paint the rows, reveal the focused row, refresh the toolbar, persist the view — exists once instead of
    // once per input device. `renderSelection` stays the single way the rows are painted.
    const applySelection = ({ ids, anchorId, focusId = null }) => {
      selectedIds.clear();
      ids.forEach(id => selectedIds.add(id));
      selectionAnchorId = anchorId;
      renderSelection(focusId);
    };

    // Selection sync mutates the existing rows instead of re-rendering the table: replacing the row
    // mid-gesture would reset the browser's click counter and swallow the follow-up `dblclick`.
    const renderSelection = focusId => {
      if (focusId !== null) {
        rememberSelection(focusId);
        const index = noteIndexOf(focusId);
        if (index >= 0) {
          const scrollTop = NoteListState.scrollTopForIndex(
            index, $list.scrollTop(), $list.innerHeight(), noteList.rowHeight);
          if (scrollTop !== $list.scrollTop()) $list.scrollTop(scrollTop);
          loadVisibleNotePages(renderVisibleRows());
        }
      }
      $list.find('.anki-note-row').each((_, element) => {
        const selected = selectedIds.has($(element).data('note-id'));
        $(element).toggleClass('selected', selected).attr('aria-checked', String(selected));
      });
      renderSelectedCount();
      if (focusId !== null) {
        const row = $list.find(`.anki-note-row[data-note-id="${focusId}"]`)[0];
        row?.focus({ preventScroll: true });
      }
    };

    // `renderSelectedCount` is where the selection, the active note, and the open editor all funnel through,
    // so the page state is stored from there instead of from each of their many writers. The write is
    // debounced because the scroll position changes far faster than it is worth storing, and `flushView` is
    // what a page teardown calls. Nothing is stored before the restore has applied, so the state this page
    // starts from is never written over the one it is about to restore.
    let viewReady = false;
    let viewTimer = null;
    const viewSnapshot = () => ({
      query: currentQuery, sortField, sortDirection, scrollTop: Math.round($list.scrollTop()),
      selectedIds: [...selectedIds], activeId, editorOpen: editorOpen && activeId !== null,
      collapsedGroups: collapsedGroups(), quickSearchGroupOrder: quickSearchGroupOrder(),
    });
    const flushView = () => {
      window.clearTimeout(viewTimer);
      viewTimer = null;
      writeBrowserView(viewSnapshot());
    };
    const persistView = () => {
      if (!viewReady || viewTimer) return;
      viewTimer = window.setTimeout(flushView, config.timings.viewPersistMs);
    };

    const noteListParams = (query, skip = 0, includeIds = false) => {
      const params = new URLSearchParams({
        skip: String(skip), limit: String(pageSize), sortField, sortDirection,
        select: NOTE_LIST_FIELDS.join(','),
      });
      // A row answers the note type's own field names only for the ones a column on screen asked for, so the
      // table's field columns are named here. A note type that lacks one answers nothing for that note.
      params.set('fields', noteFieldNames().join(','));
      if (query) params.set('query', query);
      if (includeIds) params.set('includeIds', 'true');
      return params;
    };

    async function loadNotePage (page) {
      const revision = noteListRevision;
      const key = `${revision}:${page}`;
      if (loadedPages.has(page) || notePageRequests.has(key)) return;
      const pending = request(`/api/anki/notes?${noteListParams(currentQuery, page * pageSize)}`)
        .then(payload => {
          if (revision !== noteListRevision) return;
          payload.notes.forEach(note => {
            const index = noteIndexOf(note.id);
            if (index >= 0) notes[index] = { ...notes[index], ...note };
            loadedNoteIds.add(note.id);
          });
          loadedPages.add(page);
          renderVisibleRows(true);
          setNoteListStatus();
        })
        .catch(error => { if (revision === noteListRevision) setBrowserStatus(error.message, 'error'); })
        .finally(() => notePageRequests.delete(key));
      notePageRequests.set(key, pending);
      await pending;
    }

    function loadVisibleNotePages (range) {
      if (!range || !notes.length) return;
      const firstPage = Math.floor(range.first / pageSize);
      const lastPage = Math.floor(Math.max(range.first, range.end - 1) / pageSize);
      for (let page = firstPage; page <= lastPage; page++) loadNotePage(page);
    }

    async function loadNotes (query, preferredId = null, preserve = false, options = {}) {
      const { allowBusy = false, skipSave = false, preserveActive = preserve } = options;
      if (busy && !allowBusy) return;
      if (!skipSave) await editor().saveActiveNote({ silent: true });
      const revision = ++noteListRevision;
      busy = true;
      setBrowserStatus('Loading…', 'pending');
      try {
        const previousActive = preserveActive ? activeNote() : null;
        const trimmed = (query ?? '').trim();
        const payload = await request(`/api/anki/notes?${noteListParams(trimmed, 0, true)}`);
        if (revision !== noteListRevision) return;
        queryHistory.remember(trimmed);
        const summaries = new Map(payload.notes.map(note => [note.id, note]));
        notes = payload.noteIds.map(id => summaries.get(id) || { id });
        rebuildNoteIndex();
        loadedNoteIds = new Set(payload.notes.map(note => note.id));
        loadedPages = new Set([0]);
        if (preserve && previousActive?.fields) {
          const index = noteIndexOf(previousActive.id);
          if (index >= 0) notes[index] = {
            ...notes[index], fields: previousActive.fields, tags: previousActive.tags,
            modelName: previousActive.modelName, sortField: previousActive.sortField,
          };
        }
        noteTotal = payload.total;
        if (trimmed !== currentQuery) selectionMemory = null;
        currentQuery = trimmed;
        const nextActiveId = noteIndexOf(preferredId) >= 0 ? preferredId : null;
        if (preserve && editorOpen && nextActiveId !== null && !notes[noteIndexOf(nextActiveId)].fields) {
          const active = (await request(`/api/anki/notes/${nextActiveId}`)).note;
          if (revision !== noteListRevision) return;
          const index = noteIndexOf(nextActiveId);
          notes[index] = { ...notes[index], ...active };
          loadedNoteIds.add(nextActiveId);
        }
        // A refetch keeps the rows the new result still holds; a new query starts from nothing. Either way the
        // old anchor is dropped, because the range it measured belonged to the list that just went away.
        applySelection(preserve
          ? NoteSelection.containedIn(notes, currentSelection())
          : NoteSelection.none());
        activeId = nextActiveId;
        editorOpen = preserve && editorOpen && activeId !== null;
        if (!preserve) $list.scrollTop(0);
        const renderStartedAt = performance.now();
        renderBrowserList();
        editor().renderBrowserEditor();
        const renderMs = performance.now() - renderStartedAt;
        console.debug('[performance] note list', {
          ...payload._timing, ...payload.timing, renderMs, count: payload.notes.length,
        });
        setNoteListStatus();
      } catch (error) {
        setBrowserStatus(error.message, 'error');
      } finally {
        busy = false;
        renderSelectedCount();
      }
    }

    // A reload lands on the view that was left: the request above already carried the stored query and sort,
    // and the same selection, scroll position, and open editor are applied to its result. Nothing is trusted
    // blindly — an id the current result no longer holds is simply skipped.
    async function restoreView () {
      try {
        $query.val(savedView.query);
        await loadNotes(savedView.query, savedView.activeId);
        $list.scrollTop(savedView.scrollTop);
        applySelection(NoteSelection.containedIn(notes, { ids: savedView.selectedIds }));
        loadVisibleNotePages(renderVisibleRows(true));
        if (savedView.editorOpen && noteIndexOf(savedView.activeId) >= 0) {
          await editor().openNoteEditor(savedView.activeId);
        }
      } finally {
        viewReady = true;
        flushView();
      }
    }

    // Previous/Next and First/Last differ only in the index they aim at, so they share one landing — and the
    // preview cursor lands through it too, because the card on screen is just another way to arrive at a note.
    // What a landing means is `NoteSelection`'s answer: with the editor open it is a move of the editor, whose
    // note the selection then follows, and landing on the note already on screen changes nothing at all.
    const landOnIndex = async index => {
      const step = NoteSelection.landing(notes, currentSelection(), index, { open: editorOpen, id: activeId });
      if (!step.changed) return;
      if (step.editorId === null) applySelection(step);
      else await editor().openNoteEditor(step.editorId);
    };

    const searchSelectedNotes = () => {
      const selected = selectedNotes();
      if (busy || !selected.length) return;
      const query = selected.map(note => `nid:${note.id}`).join(' OR ');
      $query.val(query);
      loadNotes(query);
    };

    const copySelectedNotes = async () => {
      const selected = selectedNotes();
      if (busy || !selected.length) return;
      if (editorOpen && !(await editor().saveActiveNote({ silent: true })).saved) return;
      const ids = selected.map(note => note.id);
      busy = true;
      renderSelectedCount();
      try {
        await request('/api/anki/notes/batch', {
          method: 'POST', body: JSON.stringify({ action: 'copy', noteIds: ids }),
        });
        setBrowserStatus(`Copied ${formatCount(ids.length)} note${ids.length === 1 ? '' : 's'}`, 'ok');
        refreshUndoStatus();
      } catch (error) {
        setBrowserStatus(error.message, 'error');
      } finally {
        busy = false;
        renderSelectedCount();
      }
    };

    const deleteSelectedNotes = async () => {
      const ids = [...selectedIds];
      if (busy || !ids.length) return;
      busy = true;
      renderSelectedCount();
      try {
        await request('/api/anki/notes/batch', {
          method: 'POST', body: JSON.stringify({ action: 'delete', noteIds: ids }),
        });
        const deletedIds = new Set(ids);
        notes = notes.filter(note => !deletedIds.has(note.id));
        deletedIds.forEach(id => loadedNoteIds.delete(id));
        rebuildNoteIndex();
        loadedPages.clear();
        noteTotal = Math.max(0, noteTotal - ids.length);
        if (deletedIds.has(activeId)) {
          activeId = null;
          editorOpen = false;
        }
        applySelection(NoteSelection.none());
        renderBrowserList();
        editor().renderBrowserEditor();
        refreshQuickSearchTags();
        setNoteListStatus();
        setBrowserStatus(`Deleted ${formatCount(ids.length)} note${ids.length === 1 ? '' : 's'}`, 'ok');
        refreshUndoStatus();
      } catch (error) {
        setBrowserStatus(error.message, 'error');
      } finally {
        busy = false;
        renderSelectedCount();
      }
    };

    const applyUndoStatus = status => {
      undoName = status?.undoName ?? null;
      redoName = status?.redoName ?? null;
      renderSelectedCount();
    };

    const refreshUndoStatus = async () => {
      try {
        applyUndoStatus((await request('/api/anki/undo-status')).status);
      } catch { /* advisory only; buttons simply stay as they were */ }
    };

    // Anki's own global undo stack can revert or replay anything the collection just did, not only a note's
    // own writes, so the reload after either one is a full reload rather than a local patch.
    const applyHistoryAction = async (action, name) => {
      if (busy || !name) return;
      busy = true;
      renderSelectedCount();
      try {
        applyUndoStatus((await request(`/api/anki/${action}`, { method: 'POST' })).status);
        setBrowserStatus(`${action === 'undo' ? 'Undid' : 'Redid'} ${name}`, 'ok');
        await loadNotes(currentQuery, activeId, true, {
          allowBusy: true, skipSave: true, preserveActive: false,
        });
        refreshQuickSearchTags();
      } catch (error) {
        setBrowserStatus(error.message, 'error');
      } finally {
        busy = false;
        renderSelectedCount();
      }
    };

    const undoLastAction = () => applyHistoryAction('undo', undoName);
    const redoLastAction = () => applyHistoryAction('redo', redoName);

    return {
      savedView,
      notes: () => notes,
      selectedIds: () => selectedIds,
      activeId: () => activeId,
      currentQuery: () => currentQuery,
      draftNote: () => draftNote,
      isBusy: () => busy,
      setBusy: value => { busy = value; },
      isEditorOpen: () => editorOpen,
      setEditorOpen: value => { editorOpen = value; },
      editorBase: () => editorBase,
      setEditorBase: value => { editorBase = value; },
      setDraftNote: note => { draftNote = note; },
      setActiveId: id => { activeId = id; },
      sortField: () => sortField,
      sortDirection: () => sortDirection,
      setSort: next => { sortField = next.field; sortDirection = next.direction; },
      activeNote, noteFields, noteTitle, notePreview, noteIndexOf, rememberSelection, selectionMemoryIndex,
      rebuildNoteIndex,
      trackLoadedNote: id => loadedNoteIds.add(id),
      clearLoadedPages: () => loadedPages.clear(),
      bumpNoteTotal: () => { noteTotal++; },
      currentSelection, applySelection, renderSelection, selectedNotes, publishChatSelection,
      setNoteListStatus, flushView, persistView,
      fetchNote, refreshNoteRows,
      loadNotes, loadVisibleNotePages, restoreView, landOnIndex,
      searchSelectedNotes, copySelectedNotes, deleteSelectedNotes,
      canUndo: () => Boolean(undoName), canRedo: () => Boolean(redoName),
      undoName: () => undoName, redoName: () => redoName,
      refreshUndoStatus, undoLastAction, redoLastAction,
    };
  };

  return { createNoteBrowserState };
});
