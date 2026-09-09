((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroListFields = api;
})(globalThis, () => {
  // The List Fields panel: the two panes that add, remove and reorder the note list's columns. The columns are a
  // client-side preference of the table, so this panel writes them through the table's own column controller
  // instead of a settings route. That controller is built by the browser, which is wired after this dialog, so
  // it is handed in once it exists — and the panel then reads the table's own state back instead of keeping a
  // copy of it: the left pane is the columns the table shows in the order it shows them, and the right pane is
  // every column it could show, which is where a column a reader takes off comes from again.
  const createListFields = ({ $, CaroUI }) => {
    const { set: setSystemMessage } = CaroUI.status;
    const { fillOptions } = CaroUI.fields;
    const { escapeAttr, escapeHtml } = CaroUI.text;

    let noteListColumns = null;
    let listFieldClickSuppressed = false;
    const setAnkiListFieldsStatus = (text, kind = '') =>
      setSystemMessage($('#ankiListFieldsStatus'), text, kind);

    // The gesture is served on the pointer, so the click it also fires is dropped — the same one-shot flag the
    // table's own header uses, for the same reason: a drag must not also read as a press on the row it started on.
    const suppressListFieldClick = () => {
      listFieldClickSuppressed = true;
      window.setTimeout(() => { listFieldClickSuppressed = false; }, 0);
    };
    // A row carries the whole answer a press needs — which column it is, which pane it is drawn in, and whether it
    // can move — so neither the handlers nor the sentences they print read the table's state a second time. The
    // drag belongs to the whole row, and the grip is only the mark that says so: it is drawn on every active row so
    // the labels line up, and it dims on the one row that cannot move.
    const listFieldRow = (column, pane) => {
      const isActive = pane === 'active';
      const action = isActive ? 'Remove this column' : 'Add this column';
      const hint = column.draggable
        ? `Drag to reorder, or press Alt+Shift+Up/Down — ${action}`
        : action;
      return `
        <div class="anki-column-row${isActive ? ' is-active' : ''}${column.pinned ? ' is-pinned' : ''}"
          data-column-key="${escapeAttr(column.key)}" data-pane="${pane}"
          data-roster-group="${column.kind === 'field' ? 'fields' : 'native'}"
          data-draggable="${column.draggable ? 'true' : 'false'}"
          role="button" tabindex="0" title="${escapeAttr(hint)}"
          aria-label="${escapeAttr(`${column.label} — ${action}`)}">
          ${isActive ? '<span class="anki-column-grip" aria-hidden="true">⋮⋮</span>' : ''}
          <span class="anki-column-label">${escapeHtml(column.label)}</span>
          ${column.pinned ? '<span class="anki-column-pinned">ALWAYS SHOWN</span>' : ''}
        </div>`;
    };

    const renderAnkiListFields = () => {
      const active = noteListColumns ? noteListColumns.listEntries() : [];
      const roster = noteListColumns ? noteListColumns.rosterEntries() : { native: [], fields: [] };
      if (!active.length && !roster.native.length && !roster.fields.length) {
        fillOptions($('#ankiListFieldsActive'), '');
        fillOptions($('#ankiListFieldsNative'), '');
        fillOptions($('#ankiListFieldsFieldRoster'), '');
        $('#ankiListFieldsFields').prop('hidden', true);
        $('#ankiListFieldsHint').text('Open the browser so its note types can be read.');
        $('#ankiListFieldsReset').prop('disabled', true);
        return;
      }
      fillOptions($('#ankiListFieldsActive'), active.map(column => listFieldRow(column, 'active')).join(''));
      fillOptions($('#ankiListFieldsNative'), roster.native.map(column => listFieldRow(column, 'roster')).join(''));
      fillOptions($('#ankiListFieldsFieldRoster'),
        roster.fields.map(column => listFieldRow(column, 'roster')).join(''));
      $('#ankiListFieldsFields').prop('hidden', !roster.fields.length);
      $('#ankiListFieldsHint').text(
        'Press a column on the left to take it off the table, and one on the right to add it to the end. Drag a '
        + 'row to reorder it; every change lands in the table at once.');
      $('#ankiListFieldsReset').prop('disabled', noteListColumns.isDefaultLayout());
      setAnkiListFieldsStatus('');
    };
    const setNoteListColumns = columns => { noteListColumns = columns || null; };

    // This panel writes as it is used — there is no save to forget. A press goes straight through the table's own
    // controller and the panes are repainted from what that controller answers, so the columns on screen and the
    // table behind the dialog cannot disagree.
    const pressListFieldRow = $row => {
      const isActive = $row.attr('data-pane') === 'active';
      if (isActive && $row.attr('data-draggable') !== 'true') return;
      const key = $row.attr('data-column-key');
      const applied = isActive
        ? noteListColumns.deactivateColumn(key)
        : noteListColumns.activateColumn(key);
      if (!applied) return;
      // The write already repainted both panes through the table's change event, so the sentence is written last.
      setAnkiListFieldsStatus(isActive ? 'Column removed.' : 'Column added.', 'ok');
    };
    $('#quickListFieldsPanel').on('click', '.anki-column-row', event => {
      if (!noteListColumns || listFieldClickSuppressed) return;
      pressListFieldRow($(event.currentTarget));
    });
    // Enter and Space press a row the way a click does, so the panel is usable without a pointer at all.
    $('#quickListFieldsPanel').on('keydown', '.anki-column-row', event => {
      if (!noteListColumns || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      pressListFieldRow($(event.currentTarget));
    });

    // A drag here is the same gesture the table's header uses, on the panel's own rows, and the drop hands the
    // move to the controller that owns the order — the panel never rearranges its own list. The whole row is the
    // handle, so a reader grabs a column wherever they read it, and a press that stays inside the threshold still
    // falls through to the row's own action.
    const listFieldRows = () => $('#ankiListFieldsActive .anki-column-row')
      .filter((_, row) => row.dataset.draggable === 'true');
    const clearListFieldDrop = () => $('#ankiListFieldsActive .anki-column-row')
      .removeClass('is-column-drop-before is-column-drop-after');
    $('#ankiListFieldsActive').on('pointerdown', '.anki-column-row', event => {
      if (event.button !== 0 || !noteListColumns) return;
      const row = event.currentTarget;
      const sourceKey = row.dataset.columnKey;
      if (!sourceKey || row.dataset.draggable !== 'true') return;
      const pointerId = event.pointerId;
      const startY = event.clientY;
      let dragging = false;
      let dropTarget = null;
      const move = moveEvent => {
        if (moveEvent.pointerId !== pointerId) return;
        if (!dragging && Math.abs(moveEvent.clientY - startY) < 6) return;
        if (!dragging) {
          dragging = true;
          row.classList.add('is-column-dragging');
          document.body.classList.add('is-reordering-columns');
        }
        moveEvent.preventDefault();
        clearListFieldDrop();
        dropTarget = null;
        const over = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)
          ?.closest('.anki-column-row');
        const targetKey = over?.dataset.columnKey;
        if (!over || over.dataset.pane !== 'active' || over.dataset.draggable !== 'true'
          || !targetKey || targetKey === sourceKey) return;
        const { top, height } = over.getBoundingClientRect();
        const after = moveEvent.clientY > top + height / 2;
        dropTarget = { key: targetKey, after };
        over.classList.add(after ? 'is-column-drop-after' : 'is-column-drop-before');
      };
      const stop = (stopEvent, commit) => {
        if (stopEvent.pointerId !== pointerId) return;
        row.removeEventListener('lostpointercapture', cancel);
        if (row.hasPointerCapture(pointerId)) row.releasePointerCapture(pointerId);
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', cancel);
        window.removeEventListener('blur', cancelOnBlur);
        clearListFieldDrop();
        row.classList.remove('is-column-dragging');
        document.body.classList.remove('is-reordering-columns');
        if (!dragging) return;
        suppressListFieldClick();
        if (commit && dropTarget) noteListColumns.reorderColumns(sourceKey, dropTarget.key, dropTarget.after);
        if (commit && dropTarget) setAnkiListFieldsStatus('Column order saved.', 'ok');
      };
      const finish = event => stop(event, true);
      const cancel = event => stop(event, false);
      const cancelOnBlur = () => stop({ pointerId }, false);
      row.setPointerCapture(pointerId);
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', cancel);
      row.addEventListener('lostpointercapture', cancel);
      window.addEventListener('blur', cancelOnBlur);
    });
    // The keyboard route to the same move, so reordering does not need a pointer at all.
    $('#ankiListFieldsActive').on('keydown', '.anki-column-row', event => {
      if (!noteListColumns || !event.altKey || !event.shiftKey) return;
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const sourceKey = $(event.currentTarget).data('column-key');
      const order = listFieldRows().toArray().map(row => row.dataset.columnKey);
      const targetKey = order[order.indexOf(sourceKey) + (event.key === 'ArrowUp' ? -1 : 1)];
      if (!targetKey) return;
      event.preventDefault();
      if (!noteListColumns.reorderColumns(sourceKey, targetKey, event.key === 'ArrowDown')) return;
      setAnkiListFieldsStatus('Column order saved.', 'ok');
      $('#ankiListFieldsActive .anki-column-row')
        .filter((_, element) => element.dataset.columnKey === sourceKey).trigger('focus');
    });

    // One press, and the button says so by being disabled while there is nothing left to reset.
    $('#ankiListFieldsReset').on('click', () => {
      if (!noteListColumns) return;
      noteListColumns.resetDefaults();
      setAnkiListFieldsStatus('List fields reset.', 'ok');
    });
    $(document).on('anki-list-fields-changed', renderAnkiListFields);

    return {
      render: renderAnkiListFields,
      setColumns: setNoteListColumns,
      setPanelStatus: setAnkiListFieldsStatus,
    };
  };

  return { createListFields };
});
