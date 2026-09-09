((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteListColumns = api;
})(globalThis, () => {
  // The table definition is the single source of truth for the note list: it builds the <colgroup> and the
  // header row, and it fixes which saved column widths are still valid.
  //
  // A column is one of two things. The first is Anki's own facts about a note and its card — its note type, its
  // deck, its tags, its flag, the field it sorts by, when it was created, when it is due, and the scheduling
  // numbers Anki's own card browser shows. The second is one note type field, named exactly as the collection
  // spells it: a note type that does not have that field answers nothing for that note rather than hiding the
  // row, which is what lets one table show a collection of mixed note types.
  //
  // Which of them are on screen is one ordered list. The row number is pinned — it is how a row is counted
  // rather than a fact about the note, so it is always active and always first — and every other column is
  // either in that list or waiting in the roster the settings panel offers it from.
  const NATIVE_COLUMNS = [
    { key: 'index', label: '#', className: 'anki-note-index', reorderable: false },
    { key: 'note-type', label: 'Note Type', active: true },
    { key: 'deck', label: 'Deck', active: true },
    { key: 'tags', label: 'Tags', active: true },
    { key: 'sort-field', label: 'Sort Field', field: 'sortField' },
    { key: 'created', label: 'Created', field: 'createdAt', active: true },
    { key: 'due', label: 'Due', field: 'dueAt', active: true },
    { key: 'interval', label: 'Interval', field: 'interval' },
    { key: 'ease', label: 'Ease', field: 'ease' },
    { key: 'reps', label: 'Reps', field: 'reps' },
    { key: 'lapses', label: 'Lapses', field: 'lapses' },
    { key: 'flag', label: 'Flag', className: 'anki-note-flag', active: true },
  ].map(column => ({ reorderable: true, ...column }));
  // A column that cannot be reordered cannot be taken off the table either: it is how a row is counted.
  const PINNED_KEYS = NATIVE_COLUMNS.filter(({ reorderable }) => !reorderable).map(({ key }) => key);
  // What a browser that has never been touched opens with: Anki's own facts beside the note, and none of the
  // scheduling numbers, which a reader who wants them adds from the roster. No note type field opens a column,
  // because which fields a note type has is the collection's fact rather than this app's default.
  const DEFAULT_ACTIVE_KEYS = [...PINNED_KEYS,
    ...NATIVE_COLUMNS.filter(({ active }) => active).map(({ key }) => key)];
  const FIELD_PREFIX = 'field:';
  const columnForField = name => ({
    key: `${FIELD_PREFIX}${name}`, label: name, field: name, isField: true, reorderable: true,
  });
  const fieldOf = column => (column.isField ? column.field : null);
  // Every column the table can show, in the roster's own order: Anki's columns, then one per note type field.
  const allColumns = fieldNames => [...NATIVE_COLUMNS, ...(fieldNames ?? []).map(columnForField)];
  // A column is looked up by its key, and a field column names its own field in that key: it resolves before
  // the collection's field list has arrived, so a restored field column is on the table from its first paint
  // instead of appearing a moment after Anki's own columns. Which fields a note type does have is still the
  // collection's fact — the roster and the pruning in `setModelFields` are what read it.
  const columnForKey = key => {
    const text = String(key);
    const field = text.startsWith(FIELD_PREFIX) ? text.slice(FIELD_PREFIX.length) : '';
    return field ? columnForField(field) : NATIVE_COLUMNS.find(column => column.key === text);
  };
  // Deduplicated the way Anki labels fields: case-insensitively, the first spelling winning.
  const uniqueNames = (names, limit = Infinity) => {
    const seen = new Map();
    for (const name of names) {
      const key = String(name).toLowerCase();
      if (name && !seen.has(key)) seen.set(key, name);
    }
    return [...seen.values()].slice(0, limit);
  };
  // Every field name any note type in the collection has, in the collection's own spelling: what the roster's
  // second group offers, and the whole of what this table can turn into a field column.
  const candidateFieldNames = modelFields => uniqueNames(modelFields || []);

  // The row number leads the active list whatever was stored, because it cannot be taken off the table.
  const pinFirst = keys => [...PINNED_KEYS, ...keys.filter(key => !PINNED_KEYS.includes(key))];

  // A stored active list is trusted only where the column still exists: a note type field the collection no
  // longer has is dropped with it, and a column this app no longer has is dropped too. Nothing has to be
  // recorded to take a column off the table — a column that is not in this list waits in the roster.
  //
  // `modelFields` undefined means the collection's fields are not known yet, which is the state this widget is
  // built in; a field column is kept rather than dropped then, because the fields arrive in a later read and a
  // saved field column that was pruned before it arrived would vanish on every reload. An empty array is the
  // different, known fact that the collection has no fields at all.
  const normalizeActiveKeys = (value, modelFields) => {
    const fieldsUnknown = modelFields === undefined;
    const known = new Set(allColumns(modelFields ?? []).map(({ key }) => key));
    const keeps = key => known.has(key) || (fieldsUnknown && String(key).startsWith(FIELD_PREFIX));
    return pinFirst([...new Set(Array.isArray(value) ? value : [])].filter(keeps));
  };

  // What one list row asks the server for: Anki's own row keys plus the note type's field values, which the
  // row answers only for the names the search named. `fields` is not here because a row carries
  // `fieldValues` instead; the read that refreshes one row in place answers a single note, which carries the
  // full `fields` list, so that read derives from this one on purpose — a hand-written subset is how the
  // Created column went blank after a due-date change, until the page was reloaded.
  const NOTE_LIST_FIELDS = ['modelName', 'tags', 'createdAt', 'deckName', 'dueAt', 'flag', 'sortField',
    'fieldValues', 'ease', 'interval', 'reps', 'lapses'];
  // A scheduling number a row answers as a number, which is what the table sorts it as.
  const NUMERIC_FIELDS = ['ease', 'interval', 'reps', 'lapses'];
  const NOTE_ROW_READ_FIELDS = [...NOTE_LIST_FIELDS.filter(field => field !== 'fieldValues'), 'fields'];

  // Moving a column is a move inside the active list. The row number cannot move, and a key that is not on the
  // table is not there to be moved, so both leave the list exactly as it was.
  const moveColumn = (order, sourceKey, targetKey, after = false) => {
    if (sourceKey === targetKey || !order.includes(sourceKey) || !order.includes(targetKey)) return order;
    if (PINNED_KEYS.includes(sourceKey) || PINNED_KEYS.includes(targetKey)) return order;
    const next = order.filter(key => key !== sourceKey);
    next.splice(next.indexOf(targetKey) + (after ? 1 : 0), 0, sourceKey);
    return pinFirst(next);
  };

  // Column layout belongs to this widget: it persists keyed widths and the active list, while the table view
  // renders from its orderedColumns accessor. A header's right edge still resizes; dragging its body reorders.
  const createNoteListColumns = ({ $, $list, config, setStatus, onOrderChange }) => {
    const { columnMin } = config.ankiBrowser.noteList;
    const { ankiNoteColumnWidths: widthsKey, ankiNoteColumns: activeKey } = config.storageKeys;
    const readStored = key => {
      try { return JSON.parse(localStorage.getItem(key) || 'null'); }
      catch { return null; }
    };
    let modelFields = [];
    // The stored list is read before the collection's fields are known, so a field column it holds is kept for
    // `setModelFields` to judge — not pruned against an empty field list that only means "not read yet".
    let active = normalizeActiveKeys(readStored(activeKey) ?? DEFAULT_ACTIVE_KEYS);
    let suppressHeaderClick = false;
    const byKey = columnForKey;
    const tableCols = () => $list.find('.anki-note-table col');
    // The table renders the active list in its own order, and nothing else: the row number is in it because it
    // cannot be taken out of it.
    const orderedColumns = () => active.map(byKey).filter(Boolean);
    const persistActive = () => localStorage.setItem(activeKey, JSON.stringify(active));
    const columnBoundary = event => {
      const cell = event.target.closest('.anki-note-table thead th');
      if (!cell || cell.cellIndex < 1 || cell.cellIndex >= active.length - 1) return null;
      return cell.getBoundingClientRect().right - event.clientX <= 5 ? cell : null;
    };
    const clearColumnBoundary = () => $list.find('.is-column-boundary').removeClass('is-column-boundary');
    const clearColumnDropTarget = () => $list.find('.is-column-drop-before, .is-column-drop-after')
      .removeClass('is-column-drop-before is-column-drop-after');

    // A saved width belongs to the column it was measured on, so a field column keeps its size while the
    // collection's other fields come and go around it.
    const readColumnWidths = () => {
      const saved = readStored(widthsKey);
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : null;
    };
    const persistColumnWidths = () => localStorage.setItem(widthsKey, JSON.stringify(Object.fromEntries(
      tableCols().toArray().map(col => [col.dataset.columnKey, Math.round(col.getBoundingClientRect().width)]))));
    const applySavedColumnWidths = () => {
      const saved = readColumnWidths();
      if (!saved) return;
      tableCols().each((_, col) => {
        const width = Number(saved[col.dataset.columnKey]);
        if (Number.isFinite(width)) col.style.width = `${Math.max(width, columnMin)}px`;
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

    // The collection's note types arrive after this widget is built, so the active list is read against them
    // the moment they are known: a field column whose field the collection no longer has leaves the table, and
    // the roster is rebuilt from what is left. Nothing is written back for a load, so a table that is still at
    // its defaults stays at its defaults.
    const setModelFields = next => {
      modelFields = next || [];
      const pruned = normalizeActiveKeys(active, modelFields);
      if (pruned.length !== active.length) {
        active = pruned;
        persistActive();
      }
      onOrderChange();
    };
    // The settings panel writes through these, and every write repaints the table behind the dialog — there is
    // no save. A column taken from the roster joins the end of the table, which is where the reader who asked
    // for it is looking, and one taken off it goes back to the roster's own place, so nothing has to remember
    // where it was.
    const activateColumn = key => {
      if (!byKey(key) || active.includes(key)) return false;
      active = pinFirst([...active, key]);
      persistActive();
      onOrderChange();
      return true;
    };
    const deactivateColumn = key => {
      const column = byKey(key);
      if (!column || PINNED_KEYS.includes(key) || !active.includes(key)) return false;
      active = active.filter(activeKey => activeKey !== key);
      persistActive();
      onOrderChange();
      return true;
    };
    // The left pane: the columns the table shows, in the order it shows them. The row number is listed because
    // it is on the table, and pinned because it cannot be taken off it.
    const listEntries = () => orderedColumns().map(column => ({
      key: column.key,
      label: column.label,
      kind: column.isField ? 'field' : 'column',
      pinned: PINNED_KEYS.includes(column.key),
      draggable: Boolean(column.reorderable),
    }));
    // The right pane: every column that is not on the table, split into Anki's own columns and the collection's
    // note type fields, which the panel shows as two stacked blocks.
    const rosterEntries = () => {
      const available = allColumns(modelFields)
        .filter(column => !active.includes(column.key) && !PINNED_KEYS.includes(column.key));
      const entry = column => ({
        key: column.key, label: column.label, kind: column.isField ? 'field' : 'column',
      });
      return {
        native: available.filter(column => !column.isField).map(entry),
        fields: available.filter(column => column.isField).map(entry),
      };
    };
    // A reset is the table's own defaults and nothing else: the default active list, and the saved widths
    // dropped, so "default" means here what it would mean on a browser that had never been touched. The active
    // list is put back before its stored copy is dropped, because dropping it is what makes it the default. It
    // reports nothing — its caller owns the status line.
    const resetDefaults = () => {
      active = normalizeActiveKeys(DEFAULT_ACTIVE_KEYS, modelFields);
      localStorage.removeItem(activeKey);
      localStorage.removeItem(widthsKey);
      onOrderChange();
    };
    const isDefaultLayout = () => readStored(activeKey) === null && readStored(widthsKey) === null;
    const reorderColumn = (sourceKey, targetKey, after, silent = false) => {
      const next = moveColumn(active, sourceKey, targetKey, after);
      if (next.every((key, index) => key === active[index])) return false;
      active = next;
      persistActive();
      onOrderChange();
      if (!silent) setStatus('Column order saved', 'ok');
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
      if (event.button !== 0 || !byKey(sourceKey)?.reorderable) return;
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
        if (!target || targetKey === sourceKey || !byKey(targetKey)?.reorderable) return;
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
      const index = active.indexOf(sourceKey);
      const targetKey = active[index + (event.key === 'ArrowLeft' ? -1 : 1)];
      if (!byKey(sourceKey)?.reorderable || !byKey(targetKey)?.reorderable) return;
      event.preventDefault();
      if (!reorderColumn(sourceKey, targetKey, event.key === 'ArrowRight')) return;
      requestAnimationFrame(() => $list.find(`thead th[data-column-key="${sourceKey}"]`).trigger('focus'));
    });

    document.addEventListener('click', () => { suppressHeaderClick = false; });

    return {
      activateColumn,
      applySavedColumnWidths,
      deactivateColumn,
      // Which note type fields the table asks the collection for: exactly the field columns on screen, so a
      // table with no field column asks for none.
      fieldNames: () => orderedColumns().filter(({ isField }) => isField).map(({ field }) => field),
      modelFieldNames: () => candidateFieldNames(modelFields),
      headerClickSuppressed: () => suppressHeaderClick,
      isDefaultLayout,
      listEntries,
      orderedColumns,
      resetColumnWidths,
      resetDefaults,
      // A move asked for by the settings panel reports in its own line, so the table's status stays the table's.
      reorderColumns: (sourceKey, targetKey, after) => reorderColumn(sourceKey, targetKey, after, true),
      rosterEntries,
      setModelFields,
    };
  };

  return {
    NATIVE_COLUMNS, DEFAULT_ACTIVE_KEYS, PINNED_KEYS, NUMERIC_FIELDS, FIELD_PREFIX, NOTE_LIST_FIELDS,
    NOTE_ROW_READ_FIELDS, allColumns, candidateFieldNames, columnForField, columnForKey, fieldOf, moveColumn,
    normalizeActiveKeys, pinFirst,
    fieldColumns: columns => columns.filter(column => fieldOf(column)).length,
    createNoteListColumns,
  };
});
