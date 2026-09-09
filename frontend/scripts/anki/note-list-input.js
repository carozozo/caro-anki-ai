((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteListInput = api;
})(globalThis, () => {
  // Every gesture the note list answers — a click, a modifier click, an arrow, a flag shortcut, ⌘A, Esc, a
  // sort header — is wired here. The module owns the listeners and the arithmetic of a gesture; it reads the
  // page through the accessors it is handed and never writes the selection itself, because `applySelection` is
  // the page's only selection writer and `NoteSelection` is the only place a gesture is resolved.
  const createNoteListInput = ({
    $, $list, $editor, $panel, $chat,
    notes, selectedIds, activeId, isEditorOpen, isBusy, isDialogOpen,
    currentSelection, applySelection, selectedNotes, noteIndexOf, selectionMemoryIndex, visibleNoteRange,
    publishChatSelection, runBatch, openNoteEditor, renderSortIndicators, reloadList, getSort, setSort,
    columns, cardPreview, toggleTargetField, NoteSelection, NoteListState, NoteShortcuts,
  }) => {
    $(document).on('anki-clear-selection', () => {
      // The chip holds its own snapshot, so Chat is always reset here — even when the browser has nothing
      // left to deselect.
      publishChatSelection([]);
      if (isEditorOpen() && activeId() !== null) {
        applySelection(NoteSelection.single(activeId()));
        return;
      }
      if (!selectedIds().size) return;
      applySelection(NoteSelection.none());
    });

    const selectNote = (row, { metaKey, shiftKey }) => applySelection(
      NoteSelection.click(notes(), currentSelection(), $(row).data('note-id'), { metaKey, shiftKey }));

    const isRowControl = target => $(target).closest('button, a, input, select, textarea').length > 0;
    // The row a list key acts on: the focused row, or the note the selection already sits on when focus is on the
    // container itself. Clicking blank list space focuses the container instead of a row, so without this the
    // arrows would re-enter the list at the top rather than next to the selection.
    const listFocusId = () => $(document.activeElement).closest('.anki-note-row').data('note-id')
      ?? (selectedIds().has(activeId()) ? activeId() : selectedNotes()[0]?.id ?? null);

    $list.on('mousedown', '.anki-note-row', event => {
      if (event.shiftKey && !isRowControl(event.target)) event.preventDefault();
    });

    $list.on('click', '.anki-note-row', event => {
      if (isBusy() || isRowControl(event.target)) return;
      if (!window.getSelection()?.isCollapsed) return;
      selectNote(event.currentTarget, event);
    });

    // `focusedId` is the row the key came from; it only counts while a selection exists. With nothing selected
    // the arrows re-enter the list instead of doing nothing, which is the state a toggle-off or `Esc` leaves.
    const moveNoteSelection = (focusedId, key, extend) => {
      const step = NoteSelection.move(notes(), currentSelection(), {
        focusedId,
        key,
        extend,
        // Only read while nothing is selected: the row an unselected list re-enters at needs the scroll viewport.
        entryIndex: () => NoteListState.selectionEntryIndex(
          notes().length, selectionMemoryIndex(), key, visibleNoteRange()),
      });
      if (step) applySelection(step);
    };

    $list.on('keydown', '.anki-note-row', event => {
      if (isBusy() || isRowControl(event.target)) return;
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      const id = $(event.currentTarget).data('note-id');
      if (event.key === 'Enter' && selectedIds().size === 1 && selectedIds().has(id)) {
        openNoteEditor(id);
        return;
      }
      selectNote(event.currentTarget, event);
    });

    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || isBusy() || isEditorOpen()
        || !['ArrowUp', 'ArrowDown'].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey
        || NoteShortcuts.isEditable(event.target) || $(event.target).closest($list).length
        || !notes().length) return;
      const focusedId = selectedIds().has(activeId()) ? activeId() : selectedNotes()[0]?.id ?? null;
      event.preventDefault();
      moveNoteSelection(focusedId, event.key, event.shiftKey);
    });

    // Every arrow key pressed inside the table lands here, whether focus sits on a row or on a column header.
    $list.on('keydown', event => {
      if (isBusy() || event.defaultPrevented) return;
      const focusId = listFocusId();
      const primaryModifier = event.metaKey || event.ctrlKey;
      if (['ArrowUp', 'ArrowDown'].includes(event.key) && !primaryModifier && !event.altKey
        && !isRowControl(event.target)) {
        event.preventDefault();
        moveNoteSelection(focusId, event.key, event.shiftKey);
      } else if (event.key === 'Escape' && selectedIds().size) {
        event.preventDefault();
        applySelection(NoteSelection.none(focusId));
      }
    });

    // The card browser owns a key while it is the focus context: the panel itself (rows, headers, the table, its
    // toolbar, the search and quick-search controls) or nothing at all, which is what a re-render leaves behind.
    // The open editor, an open dialog, editable controls, and the chat's own lists keep their own behaviour.
    const browserOwnsKeys = target => !isEditorOpen() && !isDialogOpen()
      && !NoteShortcuts.isEditable(target)
      && (target === document.body || ($panel[0].contains(target) && !$chat[0].contains(target)));

    // ⌘A takes the whole result whenever the browser owns the key; an empty selection or a pointer that never
    // touched the table is no reason to fall back to a page-wide select-all. Drag-selected text keeps its own.
    document.addEventListener('keydown', event => {
      const selectAllShortcut = NoteShortcuts.find('select-all');
      if (event.defaultPrevented || isBusy() || !NoteShortcuts.matches(event, selectAllShortcut)
        || !(window.getSelection()?.isCollapsed ?? true) || !browserOwnsKeys(event.target)) return;
      event.preventDefault();
      if (!notes().length) return;
      const focusId = $(event.target).closest('.anki-note-row').data('note-id') ?? null;
      applySelection(NoteSelection.all(notes(), currentSelection(), focusId));
    });

    document.addEventListener('keydown', event => {
      const htmlShortcut = NoteShortcuts.find('toggle-html');
      if (event.defaultPrevented || isBusy() || !isEditorOpen() || !NoteShortcuts.matches(event, htmlShortcut)) return;
      event.preventDefault();
      toggleTargetField().find('.anki-rich-toggle').trigger('click');
    });

    // Every shortcut the page documents is dispatched here, and it is the same handler the note preview reads:
    // the dialog's own twin buttons answer the chord that pressed them instead of the list's.
    document.addEventListener('keydown', event => {
      const isNoteEditorInput = isEditorOpen() && $editor[0].contains(event.target);
      // Every shortcut here needs a primary modifier and the mode picker is its own control, so a focused
      // control inside the preview is no reason to ignore the keys that drive that preview.
      const inPreviewDialog = cardPreview().isOpen()
        && cardPreview().contains(event.target);
      if (event.defaultPrevented || isBusy() || (isDialogOpen() && !inPreviewDialog)
        || (NoteShortcuts.isEditable(event.target) && !isNoteEditorInput && !inPreviewDialog)) return;
      const shortcut = NoteShortcuts.definitions.find(item => item.scope === 'browser' && item.selector
        && NoteShortcuts.matches(event, item));
      if (!shortcut || (shortcut.id === 'copy' && window.getSelection()?.toString())) return;
      const $button = $(cardPreview().isOpen() && shortcut.previewSelector
        ? shortcut.previewSelector
        : shortcut.selector);
      if ($button.prop('disabled') || $button.prop('hidden')) return;
      event.preventDefault();
      $button.trigger('click');
    });

    // ⌘1-⌘7 flag every selected note, but each is a toggle: when every selected note already carries
    // that flag, the shortcut clears it instead; a mixed selection applies the requested flag to every note.
    const toggleSelectedFlags = flag => {
      const selected = notes().filter(note => selectedIds().has(note.id));
      if (isBusy() || !selected.length) return;
      const clearing = selected.every(note => note.flag === flag);
      runBatch('setFlag', { flag: clearing ? 0 : flag },
        clearing ? `flag ${flag} cleared` : `flag ${flag} set`);
    };

    // ⌘1-⌘7 are dispatched at the document because a batch write replaces the row that had focus, leaving the
    // page body — not the table — to carry the next flag key. Every other key the table owns still lands on it.
    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || isBusy() || !browserOwnsKeys(event.target)) return;
      const flagShortcut = NoteShortcuts.definitions.find(shortcut => shortcut.action === 'flag'
        && NoteShortcuts.matches(event, shortcut));
      if (!flagShortcut) return;
      event.preventDefault();
      toggleSelectedFlags(flagShortcut.flag);
    });

    const applySort = field => {
      const { field: sorted, direction } = getSort();
      // A second click on the sorted header flips it; a new field starts at the direction that field reads best
      // in, which is newest-first for the two dates and A-Z for the text columns.
      setSort(field === sorted
        ? { field, direction: direction === 'asc' ? 'desc' : 'asc' }
        : { field, direction: field === 'createdAt' || field === 'dueAt' ? 'desc' : 'asc' });
      renderSortIndicators();
      reloadList();
    };

    $list.on('click', '.anki-note-sortable', event => {
      if (columns.headerClickSuppressed() || isBusy()) return;
      applySort($(event.currentTarget).data('sort-field'));
    });

    $list.on('keydown', '.anki-note-sortable', event => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      $(event.currentTarget).trigger('click');
    });

    return { moveNoteSelection };
  };

  return { createNoteListInput };
});
