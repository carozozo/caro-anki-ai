((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BatchDialog = api;
})(globalThis, () => {
  // One modal dialog serves both batch actions: it carries the control of the active one and the short
  // explanation of what it does and which values it accepts, so the shortcut needs no UI memory. The mode
  // picks the field the dialog shows, and the dialog owns the two toolbar buttons that open it.
  //
  // A new-note draft is the one target it acts on without a note id: the draft's deck is only remembered for
  // the create call, so a deck change there is set on the draft and never sent anywhere. A failure keeps the
  // dialog open, so the value can be corrected without reopening it.
  const createBatchDialog = ({
    $, createDialog, request, setStatus, deckOptions, draftNote, selectedIds, selectedNotes,
    isBusy, setBusy, refreshNoteRows, renderEditorDeck, CaroUI,
  }) => {
    const { formatCount } = CaroUI.text;
    const MODES = {
      deck: {
        action: 'changeDeck',
        title: 'Change deck',
        hint: count => `Move ${formatCount(count)} selected note${count === 1 ? '' : 's'} to another deck.`,
        help: 'Every card of the selected notes moves to the destination deck.',
        param: value => ({ deck: value }),
        success: value => `Switched to deck "${value}"`,
        value: () => $('#ankiBatchDeck').val(),
      },
      due: {
        action: 'setDueDate',
        title: 'Set due time',
        hint: count => `Set the due time of ${formatCount(count)} selected note${
          count === 1 ? '' : 's'}.`,
        help: 'A day count such as 1 (tomorrow), or an ascending range such as 1-3 to spread the notes.',
        param: value => ({ days: value }),
        success: value => `Set due date to ${value}`,
        value: () => $('#ankiBatchDue').val().trim(),
      },
    };
    const $dialog = $('#ankiBatchDialog');
    const setError = text => $('#ankiBatchDialogError').text(text);
    // A closed dialog forgets which action it showed, and the error it may have reported goes with it.
    let mode = null;
    const reset = () => { mode = null; setError(''); };
    const dialog = createDialog({ selector: '#ankiBatchDialog', onClose: reset });

    const open = next => {
      // A draft is the dialog's deck target of its own: it has no note id to put in the selection.
      // A saved note leaves a fresh draft in the editor. A selected saved note must still win over it.
      const ids = selectedIds();
      const draft = next === 'deck' && !ids.size ? draftNote() : null;
      const count = ids.size || (draft ? 1 : 0);
      if (isBusy() || !count) return;
      const config = MODES[next];
      // The picker opens on the deck the notes already sit in — the draft's own, or the first selected note's
      // — so a move is one step from where the user is rather than from an unrelated first option.
      const currentDeck = next === 'deck' ? (draft?.deckName || selectedNotes()[0]?.deckName) : null;
      const $control = next === 'deck'
        ? $('#ankiBatchDeck').html(deckOptions(currentDeck))
        : $('#ankiBatchDue').val('');
      if (currentDeck) $control.val(currentDeck);
      mode = next;
      $('#ankiBatchDialogTitle').text(config.title);
      $('#ankiBatchDialogHint').text(draft ? 'Set the deck this new note is created in.' : config.hint(count));
      $('#ankiBatchDialogHelp').text(config.help);
      setError('');
      $dialog.find('.dialog-field').each((_, field) =>
        $(field).prop('hidden', $(field).data('dialog-field') !== next));
      dialog.open();
      // Focus only. Opening the native select popup here would anchor it to the layout rect from before the
      // dialog finished layering, leaving the list offset from its field, so the user opens it by clicking.
      $control[0].focus();
    };

    // One write for every batch action there is: the dialog's own pending value, and the flag shortcuts that
    // reuse it without opening the dialog.
    const run = async (action, values, successText) => {
      const ids = [...selectedIds()];
      const draft = action === 'changeDeck' && !ids.length ? draftNote() : null;
      if (isBusy() || (!ids.length && !draft)) return;
      setBusy(true);
      try {
        if (draft) draft.deckName = values.deck;
        else {
          await request('/api/anki/notes/batch', {
            method: 'POST',
            body: JSON.stringify({ action, noteIds: ids, ...values }),
          });
          await refreshNoteRows(ids);
        }
        // Never a full editor render: it would throw away the fields being typed, and a deck move is the
        // only change the open editor shows.
        renderEditorDeck();
        dialog.close();
        setStatus(draft
          ? `New note will be created in deck "${values.deck}"`
          : `Updated ${formatCount(ids.length)} note${ids.length === 1 ? '' : 's'}: ${successText}`, 'ok');
      } catch (error) {
        setStatus(error.message, 'error');
        setError(error.message);
      } finally {
        setBusy(false);
      }
    };

    const confirm = () => {
      const config = MODES[mode];
      const value = config?.value();
      if (!config || !value) return;
      run(config.action, config.param(value), config.success(value));
    };

    // Each picker applies on its own: a deck change commits immediately, and Enter commits whatever the
    // focused control holds — including a deck already selected, which fires no change event.
    const applyOnEnter = selector => $(selector).on('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      confirm();
    });
    $('#ankiChangeDeck').on('click', () => open('deck'));
    $('#ankiSetDueDate').on('click', () => open('due'));
    $('#ankiBatchDeck').on('change', confirm);
    applyOnEnter('#ankiBatchDeck');
    applyOnEnter('#ankiBatchDue');

    return { close: () => dialog.close(), run };
  };

  return { createBatchDialog };
});
