((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteListView = api;
})(globalThis, () => {
  // The note list is one view of the controller's state: the virtualized table, its sort headers, its flag
  // badges and the selection readout the toolbar follows. It reads that state through accessors and owns no
  // note, no selection and no page, so a scroll, a sort, a selection repaint, and a full reload all end in
  // the same renderer.
  const createNoteListView = ({
    $, $list, config, CaroUI, NoteListState, columns,
    noteTitle, noteIndexOf, loadVisibleNotePages, persistView, closeBatchDialog, deckNames,
    notes, selectedIds, activeId, draftNote, editorOpen, busy, sortField, sortDirection,
    canUndo, canRedo,
  }) => {
    const { noteMeaning, optionsHtml } = CaroUI.fields;
    const { escapeAttr, escapeHtml, formatCount, formatDateTime } = CaroUI.text;
    const { rowHeight, overscan } = config.ankiBrowser.noteList;
    // The row the table was last rendered from: a scroll that does not move it needs no re-render, and
    // `renderBrowserList` invalidates it because the table it replaces is a new one.
    let virtualStart = -1;
    let virtualFrame = 0;

    const headerClass = column => [column.className, column.reorderable && 'is-column-draggable']
      .filter(Boolean).join(' ');
    const reorderHint = column => column.reorderable ? '; drag to reorder (Alt+Shift+Left/Right)' : '';
    const sortableHeader = column =>
      `<th class="anki-note-sortable ${headerClass(column)}" data-column-key="${column.key}"
        data-sort-field="${column.field}" role="button" tabindex="0" aria-sort="none"
        title="Sort by ${column.label}${reorderHint(column)}"><span class="anki-note-sort-label">${column.label}</span>`
      + '<span class="anki-note-sort-indicator" aria-hidden="true"></span></th>';
    const columnHeader = column => {
      if (column.field) return sortableHeader(column);
      const className = headerClass(column);
      const keyboard = column.reorderable ? ' tabindex="0" title="Drag to reorder (Alt+Shift+Left/Right)"' : '';
      return `<th${className ? ` class="${className}"` : ''} data-column-key="${column.key}"${keyboard}>`
        + `${column.label}</th>`;
    };

    function renderSortIndicators () {
      const field = sortField();
      const order = sortDirection();
      $list.find('.anki-note-sortable').each((_, header) => {
        const $header = $(header);
        const active = $header.data('sort-field') === field;
        $header.toggleClass('is-sorted-asc', active && order === 'asc')
          .toggleClass('is-sorted-desc', active && order === 'desc')
          .attr('aria-sort', active ? (order === 'asc' ? 'ascending' : 'descending') : 'none')
          .find('.anki-note-sort-indicator').text(active ? (order === 'asc' ? '∧' : '∨') : '');
      });
    }

    // Anki user flags are numbered 1-7 and each number has its own colour; 0 means unflagged.
    const FLAG_NAMES = ['none', 'red', 'orange', 'green', 'blue', 'pink', 'teal', 'purple'];
    const flagBadge = flag => (Number.isSafeInteger(flag) && flag > 0
      ? `<span class="anki-note-flag-badge is-flag-${flag}" role="img" aria-label="Flag ${flag}"
          title="Flag ${flag} (${FLAG_NAMES[flag]})">${flag}</span>`
      : '');
    const loadingCell = column => (column.key === 'term'
      ? '<td class="anki-note-term muted">Loading…</td>' : '<td></td>');
    const noteCell = (column, note, index, title, meaning) => {
      switch (column.key) {
        case 'index': return `<td class="anki-note-index">${index + 1}</td>`;
        case 'flag': return `<td class="anki-note-flag-cell">${flagBadge(note.flag)}</td>`;
        case 'tags': {
          const tags = (note.tags || []).join(', ');
          return `<td class="anki-note-tags-cell" title="${escapeAttr(tags)}">${escapeHtml(tags || '—')}</td>`;
        }
        case 'note-type': return `<td class="anki-note-type-cell" title="${escapeAttr(note.modelName || '—')}">
          ${escapeHtml(note.modelName || '—')}</td>`;
        case 'deck': return `<td class="anki-note-deck-cell" title="${escapeAttr(note.deckName || '—')}">
          ${escapeHtml(note.deckName || '—')}</td>`;
        case 'term': return `<td class="anki-note-term" title="${escapeAttr(title)}">${escapeHtml(title)}</td>`;
        case 'meaning': return `<td class="anki-note-text" title="${escapeAttr(meaning)}">
          ${escapeHtml(meaning || '—')}</td>`;
        case 'created': return `<td>${formatDateTime(note.createdAt)}</td>`;
        case 'due': return `<td class="anki-note-due-cell">${formatDateTime(note.dueAt)}</td>`;
      }
    };

    const renderBrowserRow = (note, index) => {
      if (note.term === undefined && !note.fields) return `
        <tr class="anki-note-row${selectedIds().has(note.id) ? ' selected' : ''}" data-note-id="${note.id}"
          role="checkbox" tabindex="0" aria-checked="${selectedIds().has(note.id)}" aria-label="Load note ${note.id}">
          ${columns.orderedColumns().map(loadingCell).join('')}
        </tr>`;
      const title = noteTitle(note);
      const selected = selectedIds().has(note.id);
      const meaning = noteMeaning(note);
      return `
        <tr class="anki-note-row${selected ? ' selected' : ''}${note.id === activeId() ? ' active' : ''}"
          data-note-id="${note.id}" role="checkbox" tabindex="0" aria-checked="${selected}"
          aria-label="Select ${escapeAttr(title)} by clicking its row; press Enter to edit">
          ${columns.orderedColumns().map(column => noteCell(column, note, index, title, meaning)).join('')}
        </tr>
      `;
    };

    const spacerRow = height => height > 0
      ? `<tr class="anki-note-spacer" aria-hidden="true"><td colspan="${columns.orderedColumns().length}"
          style="height:${height}px"></td></tr>` : '';
    const virtualRange = () => NoteListState.visibleRange(
      notes().length, $list.scrollTop(), $list.innerHeight(), rowHeight, overscan,
    );
    // The same window without overscan: the rows actually on screen, used to place a key that enters an
    // empty selection.
    const visibleNoteRange = () => NoteListState.visibleRange(
      notes().length, $list.scrollTop(), $list.innerHeight(), rowHeight, 0,
    );
    const renderVisibleRows = (force = false) => {
      if (editorOpen()) return null;
      const { first, end } = virtualRange();
      if (!force && first === virtualStart) return { first, end };
      virtualStart = first;
      const rows = notes().slice(first, end)
        .map((note, index) => renderBrowserRow(note, first + index)).join('');
      $list.find('.anki-note-table tbody').html(notes().length
        ? `${spacerRow(first * rowHeight)}${rows}${spacerRow((notes().length - end) * rowHeight)}`
        : `<tr class="anki-note-empty"><td colspan="${columns.orderedColumns().length}">No matching notes</td></tr>`);
      return { first, end };
    };

    function renderBrowserList () {
      virtualStart = -1;
      const noteColumns = columns.orderedColumns();
      $list.html(`<table class="anki-note-table">
        <colgroup>
          ${noteColumns.map(column =>
            `<col class="anki-note-col-${column.key}" data-column-key="${column.key}">`).join('')}
        </colgroup>
        <thead><tr>
          ${noteColumns.map(columnHeader).join('')}
        </tr></thead>
        <tbody></tbody>
      </table>`);
      const range = renderVisibleRows(true);
      columns.applySavedColumnWidths();
      renderSortIndicators();
      renderBatchActions();
      loadVisibleNotePages(range);
    }

    // The list renders only the rows near the viewport, and asks the controller for the pages they belong to:
    // a scroll frame that moved the window redraws it and stores the position, a resize redraws it outright.
    $list.on('scroll', () => {
      if (virtualFrame) return;
      virtualFrame = requestAnimationFrame(() => {
        virtualFrame = 0;
        loadVisibleNotePages(renderVisibleRows());
        persistView();
      });
    });
    new ResizeObserver(() => loadVisibleNotePages(renderVisibleRows(true))).observe($list[0]);

    // A picker offers every deck, the note's own included even if the listing is stale: hiding a deck
    // from the quick search must never rewrite which deck a note appears to be in.
    const deckOptions = current => optionsHtml(
      [...new Set([...(current ? [current] : []), ...deckNames()])]);

    // The selection count is a live readout of `selectedIds`, so EVERY selection mutation must refresh it —
    // a full list render (`renderBatchActions`) or an in-place update (`renderSelection`).
    const renderSelectedCount = () => {
      const ids = selectedIds();
      const count = notes().length;
      const isBusy = busy();
      persistView();
      $('#ankiSelectedCount').text(`${formatCount(ids.size)} selected`);
      $('#ankiSelectedSearch, #ankiSelectedAi, #ankiSelectedCopy, #ankiSelectedDelete, #ankiChangeDeck, #ankiSetDueDate')
        .prop('disabled', !ids.size || isBusy);
      $('#ankiPreviewNote').prop('disabled', !notes().length || isBusy);
      // A draft has no id and can never be selected, yet its deck is what the create call will use.
      if (draftNote()) $('#ankiChangeDeck').prop('disabled', isBusy);
      const selectedId = ids.size === 1 ? ids.values().next().value : null;
      const selectedIndex = noteIndexOf(selectedId);
      // The four navigation buttons take over the arrow keys' job while nothing is selected, so they must stay
      // enabled to enter a list — never while the editor is open, where the list is not rendered.
      const entersList = !ids.size && !editorOpen() && count > 0;
      const atFirst = selectedIndex <= 0;
      const atLast = selectedIndex < 0 || selectedIndex >= count - 1;
      $('#ankiFirstNote, #ankiPreviousNote').prop('disabled', isBusy || (!entersList && atFirst));
      $('#ankiLastNote, #ankiNextNote').prop('disabled', isBusy || (!entersList && atLast));
      $('#ankiUndo').prop('disabled', isBusy || !canUndo());
      $('#ankiRedo').prop('disabled', isBusy || !canRedo());
      $('#ankiNewNote').prop('hidden', editorOpen());
    };

    // The deck/due pickers live in a modal dialog (primary+D / primary+U); the dialog is only ever closed when the
    // selection drops to nothing, so this keeps a stale prompt from outliving its selection.
    function renderBatchActions () {
      renderSelectedCount();
      if (!selectedIds().size) closeBatchDialog();
    }

    return {
      renderBrowserList, renderBrowserRow, renderSortIndicators, renderVisibleRows,
      renderSelectedCount, renderBatchActions, visibleNoteRange, deckOptions,
    };
  };
  return { createNoteListView };
});
