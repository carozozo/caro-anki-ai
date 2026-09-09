((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeckStudio = api;
})(globalThis, () => {
  // Deck Studio is Note Type Studio's shape over decks, driven by the same entity manager: a deck IS its
  // name, so identity is the string itself. Every mutation re-reads the collection through `load()`, which
  // is what keeps the quick search, the deck pickers and the batch dialog from disagreeing about which
  // decks exist.
  const createDeckStudio = ({
    $, request, CaroUI, createDialog, armedConfirm, setStatus, studyOptions, loadSettings, getSettings,
    onDecksLoaded, onDecksError,
  }) => {
    const { fillOptions, optionsHtml, pickerRow } = CaroUI.fields;
    const { set: setSystemMessage } = CaroUI.status;
    const dialog = createDialog({ selector: '#ankiDeckDialog' });
    let deckNames = [];
    let saving = false;

    const status = (text, kind = '') => setSystemMessage($('#ankiDeckStatus'), text, kind);
    const manager = CaroUI.entityManager({
      id: deck => deck,
      labelOf: deck => deck,
      list: async () => (await request('/api/anki/decks')).decks,
      create: async name => (await request('/api/anki/decks', {
        method: 'POST', body: JSON.stringify({ name }),
      })).deck.name,
      rename: async (oldName, name) => (await request(`/api/anki/decks/${encodeURIComponent(oldName)}`, {
        method: 'PUT', body: JSON.stringify({ name }),
      })).deck.name,
      remove: name => request(`/api/anki/decks/${encodeURIComponent(name)}`, { method: 'DELETE' }),
      // Anki's default deck is the fallback for a note that names no deck, so it is offered like any other
      // deck and never renamed or removed — the bridge refuses both, which is what actually protects it.
      canRename: deck => deck !== 'Default',
      canDelete: deck => deck !== 'Default',
    });

    // The collection's own list, kept beside the manager's because the quick search, the deck pickers and
    // the batch dialog all read the names a write just changed.
    const load = async () => {
      try {
        // The choice arrives with the settings, so the first load waits for them instead of offering
        // every deck for as long as the request is in flight.
        if (!getSettings()) await loadSettings();
        const payload = await request('/api/anki/decks');
        deckNames = [...new Set(payload.decks || [])].sort((a, b) => a.localeCompare(b));
        await onDecksLoaded(deckNames, payload.models || [], payload.modelFields || []);
      } catch (error) {
        onDecksError(error.message);
      }
    };

    // The row is one control that becomes the list, the open deck's name, or a name for a new one, and it is
    // Deck Studio's own writes that sit behind it: a deck is picked, made, renamed and deleted exactly the way
    // a note type is, so the row itself is the same one both dialogs are built from.
    //
    // Every write goes through here, which is what the row inherits: one at a time, with the row's own buttons
    // standing down while one is in flight, and the answer written under the deck's own name. `reload` is for the
    // writes that can change which decks the collection holds — one made, renamed or deleted — because the list
    // this dialog, the quick search and the batch dialog all draw is then read again; a write that only files one
    // deck under the study options the user just chose leaves the collection alone and is answered by the control
    // that made it, so no list is read and nothing but this dialog's own help line is redrawn.
    const withSave = async (work, success, { onSaved = () => {}, reload = true } = {}) => {
      if (saving) return;
      saving = true;
      render();
      status('Saving…', 'pending');
      try {
        await work();
        if (reload) await load();
        status(success, 'ok');
        setStatus(success, 'ok');
        // A form leaves only once the write behind it has landed, so a failed save keeps the name on screen to
        // correct instead of dropping it.
        onSaved();
      } catch (error) {
        status(error.message, 'error');
      } finally {
        saving = false;
        render();
      }
    };

    const picker = pickerRow({
      manager,
      ids: {
        select: '#ankiDeckSelect', rename: '#ankiDeckName', create: '#ankiNewDeckName',
        confirm: '#ankiDeckConfirm', back: '#ankiDeckReturn', remove: '#ankiDeleteDeck',
      },
      sentinel: '- New Deck -',
      entity: 'deck',
      isReady: () => !saving,
      run: withSave,
      // The deck's study options are drawn from the deck the collection has open, so a pick repaints the row
      // around the list as well as the list itself.
      onPick: () => render(),
      messages: { created: name => `Created deck ${name}` },
    });

    const render = () => {
      const deck = manager.selected();
      const ready = !saving;
      picker.render();
      $('#ankiDeleteDeck').prop('disabled', !(ready && manager.canDelete()));
      // The deck's preset is read from the usage every preset carries, which is the same list the Study
      // Options picker draws — so the two can never disagree about which decks a preset schedules.
      const preset = studyOptions.deckStudyOption(deck);
      const presets = studyOptions.presets();
      fillOptions($('#ankiDeckStudyOption'),
        optionsHtml(presets, { value: option => option.id, label: option => option.name }))
        .val(preset ? preset.id : '')
        .prop('disabled', !(ready && deck && presets.length));
      $('#ankiEditDeckStudyOptions').prop('disabled', !(ready && deck));
      $('#ankiDeckStudyOptionHelp').text(!deck ? 'Loading every deck in the collection…'
        : preset
          ? `This deck is scheduled with "${preset.name}", and so is every deck that names it.`
          : 'This deck names no study options this app can read.');
      $('#ankiDeckHelp').text(!deck ? 'Loading every deck in the collection…'
        : deck === 'Default'
          ? 'Anki files every note that names no deck here, so the default deck cannot be renamed or deleted.'
          : `Renaming or deleting this deck also moves or removes its subdecks, "${deck}::…" included.`);
    };

    const open = async () => {
      dialog.open();
      status('Loading decks…', 'pending');
      try {
        await Promise.all([manager.load(), studyOptions.loadPresets()]);
        render();
        status('', '');
      } catch (error) {
        status(error.message, 'error');
      }
    };

    // A write elsewhere can change the presets this dialog draws, so it redraws itself only while it shows.
    const refresh = () => { if (dialog.isOpen()) render(); };

    const deleteConfirm = armedConfirm(() => {
      const deck = manager.selected();
      if (!deck || saving) return undefined;
      return withSave(() => manager.remove(deck), `Deleted deck ${deck} and its notes`);
    });
    $('#ankiDeleteDeck').on('click', event => {
      if (saving || !manager.canDelete()) return;
      deleteConfirm.handle(event, `Click again to delete "${manager.selected()}" and its notes`);
    });
    // A deck names its own study options, so the assignment is a write on the deck: it is applied straight
    // away and every other deck that names the same preset is left exactly as it was.
    $('#ankiDeckStudyOption').on('change', event => {
      const deck = manager.selected();
      const presetId = Number(event.currentTarget.value);
      if (!deck || !presetId || studyOptions.deckStudyOption(deck)?.id === presetId) return;
      const name = studyOptions.presets().find(preset => preset.id === presetId)?.name || presetId;
      withSave(async () => {
        await request(`/api/anki/decks/${encodeURIComponent(deck)}/study-options`, {
          method: 'PUT', body: JSON.stringify({ presetId }),
        });
        await studyOptions.loadPresets();
      }, `"${deck}" is now scheduled with ${name}`, { reload: false });
    });
    $('#ankiEditDeckStudyOptions')
      .on('click', () => studyOptions.open(studyOptions.deckStudyOption(manager.selected())?.id));

    return { open, load, refresh, deckNames: () => deckNames };
  };

  return { createDeckStudio };
});
