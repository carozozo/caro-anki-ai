((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteListColumns = api;
})(globalThis, () => {
  // The table definition is the single source of truth for the note list: it builds the <colgroup> and the
  // header row, and it fixes how many saved column widths are still valid.
  const NOTE_COLUMNS = [
    { key: 'index', label: '#', className: 'anki-note-index', reorderable: false },
    { key: 'tags', label: 'Tags', reorderable: true },
    { key: 'note-type', label: 'Note Type', reorderable: true },
    { key: 'deck', label: 'Deck', reorderable: true },
    { key: 'term', label: 'Term', field: 'term', reorderable: true },
    { key: 'meaning', label: 'Meaning', field: 'meaning', reorderable: true },
    { key: 'created', label: 'Created', field: 'createdAt', reorderable: true },
    { key: 'due', label: 'Due', field: 'dueAt', reorderable: true },
    { key: 'flag', label: 'Flag', className: 'anki-note-flag', reorderable: true },
  ];
  const NOTE_COLUMN_KEYS = NOTE_COLUMNS.map(({ key }) => key);
  const NOTE_COLUMN_BY_KEY = new Map(NOTE_COLUMNS.map(column => [column.key, column]));
  const NOTE_LIST_FIELDS = ['term', 'meaning', 'modelName', 'tags', 'createdAt', 'deckName', 'dueAt', 'flag'];
  // The read that refreshes one row in place answers a single note, which carries `fields` (and its sort
  // field) instead of the `term`/`meaning` a list row is derived from. It is derived from the list above on
  // purpose: a hand-written subset is how the Created column went blank after a due-date change, until the
  // page was reloaded.
  const NOTE_ROW_READ_FIELDS = [...NOTE_LIST_FIELDS.filter(field => field !== 'term' && field !== 'meaning'),
    'fields', 'sortField'];

  const normalizeColumnOrder = value => {
    if (!Array.isArray(value) || value.length !== NOTE_COLUMN_KEYS.length
      || new Set(value).size !== NOTE_COLUMN_KEYS.length || value.some(key => !NOTE_COLUMN_BY_KEY.has(key))) {
      return [...NOTE_COLUMN_KEYS];
    }
    const fixed = NOTE_COLUMNS.filter(({ reorderable }) => !reorderable).map(({ key }) => key);
    return [...fixed, ...value.filter(key => NOTE_COLUMN_BY_KEY.get(key).reorderable)];
  };

  const moveColumn = (order, sourceKey, targetKey, after = false) => {
    const normalized = normalizeColumnOrder(order);
    const source = NOTE_COLUMN_BY_KEY.get(sourceKey);
    const target = NOTE_COLUMN_BY_KEY.get(targetKey);
    if (!source?.reorderable || !target?.reorderable || sourceKey === targetKey) return normalized;
    const next = normalized.filter(key => key !== sourceKey);
    next.splice(next.indexOf(targetKey) + (after ? 1 : 0), 0, sourceKey);
    return next;
  };

  // Column layout belongs to this widget: it persists keyed widths and the header order, while the table view
  // renders from its orderedColumns accessor. A header's right edge still resizes; dragging its body reorders.
  const createNoteListColumns = ({ $, $list, config, setStatus, onOrderChange }) => {
    const { columnMin } = config.ankiBrowser.noteList;
    const { ankiNoteColumnWidths: widthsKey, ankiNoteColumnOrder: orderKey } = config.storageKeys;
    const readStored = key => {
      try { return JSON.parse(localStorage.getItem(key) || 'null'); }
      catch { return null; }
    };
    let order = normalizeColumnOrder(readStored(orderKey));
    let suppressHeaderClick = false;
    const tableCols = () => $list.find('.anki-note-table col');
    const orderedColumns = () => order.map(key => NOTE_COLUMN_BY_KEY.get(key));
    const columnBoundary = event => {
      const cell = event.target.closest('.anki-note-table thead th');
      if (!cell || cell.cellIndex < 1 || cell.cellIndex >= NOTE_COLUMNS.length - 1) return null;
      return cell.getBoundingClientRect().right - event.clientX <= 5 ? cell : null;
    };
    const clearColumnBoundary = () => $list.find('.is-column-boundary').removeClass('is-column-boundary');
    const clearColumnDropTarget = () => $list.find('.is-column-drop-before, .is-column-drop-after')
      .removeClass('is-column-drop-before is-column-drop-after');

    const readColumnWidths = () => {
      const saved = readStored(widthsKey);
      if (Array.isArray(saved) && saved.length === NOTE_COLUMNS.length
        && saved.every(value => Number.isFinite(value))) {
        return Object.fromEntries(NOTE_COLUMNS.map((column, index) => [column.key, saved[index]]));
      }
      return saved && typeof saved === 'object' && NOTE_COLUMN_KEYS.every(key => Number.isFinite(saved[key]))
        ? saved : null;
    };
    const persistColumnWidths = () => localStorage.setItem(widthsKey, JSON.stringify(Object.fromEntries(
      tableCols().toArray().map(col => [col.dataset.columnKey, Math.round(col.getBoundingClientRect().width)]))));
    const applySavedColumnWidths = () => {
      const saved = readColumnWidths();
      if (!saved) return;
      tableCols().each((_, col) => {
        col.style.width = `${Math.max(saved[col.dataset.columnKey], columnMin)}px`;
      });
    };
    const freezeColumnWidths = () => tableCols().each((_, col) => {
      col.style.width = `${col.getBoundingClientRect().width}px`;
    });
    const resetColumnWidths = () => {
      localStorage.removeItem(widthsKey);
      tableCols().removeAttr('style');
      setStatus('Column widths reset', 'ok');
    };
    // Measure a column's intrinsic (content) width by temporarily handing the table back to auto layout.
    const intrinsicColumnWidth = column => {
      const table = $list.find('.anki-note-table')[0];
      if (!table) return null;
      const cols = [...table.querySelectorAll('col')];
      const savedStyles = cols.map(col => col.style.width);
      const { tableLayout, width, minWidth } = table.style;
      Object.assign(table.style, { tableLayout: 'auto', width: 'max-content', minWidth: '0' });
      cols.forEach(col => { col.style.width = 'auto'; });
      const measured = cols[column].getBoundingClientRect().width;
      Object.assign(table.style, { tableLayout, width, minWidth });
      cols.forEach((col, index) => { col.style.width = savedStyles[index]; });
      return measured;
    };
    // Autofit shifts the width between the column and its right neighbour so the table total stays unchanged.
    const autofitColumn = column => {
      const col = tableCols().eq(column);
      const nextCol = tableCols().eq(column + 1);
      if (!col.length || !nextCol.length) return;
      freezeColumnWidths();
      const currentWidth = col[0].getBoundingClientRect().width;
      const nextWidth = nextCol[0].getBoundingClientRect().width;
      const target = Math.max(columnMin, Math.ceil(intrinsicColumnWidth(column)));
      const delta = Math.max(columnMin - currentWidth, Math.min(target - currentWidth, nextWidth - columnMin));
      col.css('width', `${currentWidth + delta}px`);
      nextCol.css('width', `${nextWidth - delta}px`);
      persistColumnWidths();
    };

    const persistColumnOrder = () => localStorage.setItem(orderKey, JSON.stringify(order));
    const reorderColumn = (sourceKey, targetKey, after) => {
      const next = moveColumn(order, sourceKey, targetKey, after);
      if (next.every((key, index) => key === order[index])) return false;
      order = next;
      persistColumnOrder();
      onOrderChange();
      setStatus('Column order saved', 'ok');
      return true;
    };
    const markHeaderClickSuppressed = () => {
      suppressHeaderClick = true;
      window.setTimeout(() => { suppressHeaderClick = false; }, 0);
    };
    const headerAtPoint = event => document.elementFromPoint(event.clientX, event.clientY)
      ?.closest('.anki-note-table thead th');
    const startColumnReorder = (event, cell) => {
      const sourceKey = cell.dataset.columnKey;
      if (event.button !== 0 || !NOTE_COLUMN_BY_KEY.get(sourceKey)?.reorderable) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const pointerId = event.pointerId;
      let dragging = false;
      let dropTarget = null;
      const move = moveEvent => {
        if (moveEvent.pointerId !== pointerId) return;
        if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 6) return;
        if (!dragging) {
          dragging = true;
          suppressHeaderClick = true;
          cell.classList.add('is-column-dragging');
          document.body.classList.add('is-reordering-columns');
        }
        moveEvent.preventDefault();
        clearColumnBoundary();
        clearColumnDropTarget();
        dropTarget = null;
        const target = headerAtPoint(moveEvent);
        const targetKey = target?.dataset.columnKey;
        if (!target || targetKey === sourceKey || !NOTE_COLUMN_BY_KEY.get(targetKey)?.reorderable) return;
        const { left, width } = target.getBoundingClientRect();
        const after = moveEvent.clientX > left + width / 2;
        dropTarget = { key: targetKey, after };
        target.classList.add(after ? 'is-column-drop-after' : 'is-column-drop-before');
      };
      const stop = (stopEvent, commit) => {
        if (stopEvent.pointerId !== pointerId) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', cancel);
        cell.removeEventListener('lostpointercapture', cancel);
        window.removeEventListener('blur', cancelOnBlur);
        if (cell.hasPointerCapture(pointerId)) cell.releasePointerCapture(pointerId);
        clearColumnDropTarget();
        cell.classList.remove('is-column-dragging');
        document.body.classList.remove('is-reordering-columns');
        if (!dragging) return;
        if (commit && dropTarget) reorderColumn(sourceKey, dropTarget.key, dropTarget.after);
        if (commit) markHeaderClickSuppressed();
      };
      const finish = event => stop(event, true);
      const cancel = event => stop(event, false);
      const cancelOnBlur = () => stop({ pointerId }, false);
      cell.setPointerCapture(pointerId);
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', cancel);
      cell.addEventListener('lostpointercapture', cancel);
      window.addEventListener('blur', cancelOnBlur);
    };

    $list.on('pointermove', '.anki-note-table', event => {
      const cell = columnBoundary(event);
      clearColumnBoundary();
      if (cell) cell.classList.add('is-column-boundary');
    }).on('pointerleave', '.anki-note-table', clearColumnBoundary);

    $list.on('pointerdown', '.anki-note-table thead th', event => {
      if (event.altKey) {
        event.preventDefault();
        suppressHeaderClick = true;
        resetColumnWidths();
        return;
      }
      const cell = columnBoundary(event);
      if (!cell) {
        startColumnReorder(event, event.currentTarget);
        return;
      }
      event.preventDefault();
      suppressHeaderClick = true;
      const column = cell.cellIndex;
      const col = tableCols().eq(column);
      const nextCol = tableCols().eq(column + 1);
      freezeColumnWidths();
      const startX = event.clientX;
      const startWidth = col[0].getBoundingClientRect().width;
      const nextStartWidth = nextCol[0].getBoundingClientRect().width;
      let moved = false;
      cell.classList.add('is-column-resizing');
      document.body.classList.add('is-resizing');
      const resize = moveEvent => {
        moved = true;
        const delta = Math.max(columnMin - startWidth,
          Math.min(moveEvent.clientX - startX, nextStartWidth - columnMin));
        col.css('width', `${startWidth + delta}px`);
        nextCol.css('width', `${nextStartWidth - delta}px`);
      };
      const stopResize = () => {
        document.removeEventListener('pointermove', resize);
        document.removeEventListener('pointerup', stopResize);
        document.removeEventListener('pointercancel', stopResize);
        cell.classList.remove('is-column-resizing');
        document.body.classList.remove('is-resizing');
        if (moved) persistColumnWidths();
        markHeaderClickSuppressed();
      };
      document.addEventListener('pointermove', resize);
      document.addEventListener('pointerup', stopResize, { once: true });
      document.addEventListener('pointercancel', stopResize, { once: true });
    });

    // Double-clicking a header boundary autofits that column; Alt/Option-clicking a header resets its widths.
    $list.on('dblclick', '.anki-note-table thead th', event => {
      if (event.altKey) return;
      const cell = columnBoundary(event);
      if (!cell) return;
      event.preventDefault();
      suppressHeaderClick = true;
      autofitColumn(cell.cellIndex);
    });

    // The header gesture is served on the pointer, so the click it also fires is dropped — and only the one
    // that follows it, because this reset runs after the list's own sort click has read the flag.
    $list.on('keydown', '.anki-note-table thead th', event => {
      if (!event.altKey || !event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const sourceKey = event.currentTarget.dataset.columnKey;
      const index = order.indexOf(sourceKey);
      const targetKey = order[index + (event.key === 'ArrowLeft' ? -1 : 1)];
      if (!NOTE_COLUMN_BY_KEY.get(sourceKey)?.reorderable || !NOTE_COLUMN_BY_KEY.get(targetKey)?.reorderable) return;
      event.preventDefault();
      if (!reorderColumn(sourceKey, targetKey, event.key === 'ArrowRight')) return;
      requestAnimationFrame(() => $list.find(`thead th[data-column-key="${sourceKey}"]`).trigger('focus'));
    });

    document.addEventListener('click', () => { suppressHeaderClick = false; });

    return {
      applySavedColumnWidths,
      orderedColumns,
      resetColumnWidths,
      headerClickSuppressed: () => suppressHeaderClick,
    };
  };

  return {
    NOTE_COLUMNS, NOTE_LIST_FIELDS, NOTE_ROW_READ_FIELDS, normalizeColumnOrder, moveColumn, createNoteListColumns,
  };
});
