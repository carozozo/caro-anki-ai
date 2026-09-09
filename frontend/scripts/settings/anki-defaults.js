((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroAnkiDefaults = api;
})(globalThis, () => {
  // The collection defaults panel: the default note type, the duplicate rule, and the deck whitelist the quick
  // search and the Change deck picker read. It writes as it is used, so it owns the small save loop that keeps a
  // change made during a write from being dropped. The note-type and deck lists are the same collection entities
  // edited in the studios, so they are read here from the same bridge responses.
  const createAnkiDefaults = ({ $, CaroUI, request, renderAnkiAccountButton }) => {
    const { set: setSystemMessage } = CaroUI.status;
    const { entityManager } = CaroUI;
    const { fillOptions, renderEntityPicker } = CaroUI.fields;
    const { escapeAttr, escapeHtml } = CaroUI.text;

    let ankiSettingsState = null;
    let ankiModelSource = [];
    let ankiDeckSource = [];

    const setQuickSettingsStatus = (text, kind = '') => setSystemMessage($('#quickSettingsStatus'), text, kind);

    const renderAnkiRuntime = () => {
      const problem = ankiSettingsState?.runtime?.available === false ? ankiSettingsState.runtime.error : '';
      $('#ankiRuntimeState').text(problem);
    };

    // The settings form only edits collection defaults, but its note-type and deck lists are the same
    // collection entities edited in the studios. Keeping their current snapshot in managers makes every picker
    // read the same source of truth, including a saved default that is temporarily absent from a bridge response.
    const ankiModels = entityManager({
      id: model => model,
      labelOf: model => model,
      list: async () => [...new Set([
        ...(ankiSettingsState?.modelName ? [ankiSettingsState.modelName] : []), ...ankiModelSource,
      ])],
    });
    const ankiDecks = entityManager({
      id: deck => deck,
      labelOf: deck => deck,
      list: async () => ankiDeckSource,
    });

    const renderAnkiModelChoices = () => {
      const current = ankiSettingsState?.modelName || '';
      if (current) ankiModels.select(current);
      renderEntityPicker($('#ankiDefaultModel'), ankiModels);
    };

    // The deck list is a set of checkboxes rather than a select, so its markup holds the decks alone and what is
    // checked lives on the inputs: a saved choice flips one property per deck, and a list of every deck in a
    // collection is left standing — with its scroll position — instead of being rebuilt under the pointer.
    const renderAnkiDeckChoices = () => {
      const chosen = new Set(ankiSettingsState?.visibleDecks || []);
      const all = !chosen.size;
      $('#ankiDeckModeAll').prop('checked', all);
      $('#ankiDeckModeSelected').prop('checked', !all);
      fillOptions($('#ankiDeckChoices'), ankiDecks.items().map(deck => `
        <label class="anki-deck-choice">
          <input type="checkbox" value="${escapeAttr(deck)}">
          <span>${escapeHtml(deck)}</span>
        </label>`).join('') || '<p class="dialog-help">This collection has no decks yet.</p>');
      $('#ankiDeckChoices input').each((_, input) => { input.checked = chosen.has(input.value); });
      setAnkiDeckMode(all);
    };

    const setAnkiDeckMode = all => {
      $('#ankiDeckChoices').toggleClass('is-disabled', all).find('input').prop('disabled', all);
      $('#ankiDeckHint').text(all
        ? 'Quick search and Change deck list every deck in the collection.'
        : 'Quick search and Change deck list only the decks checked here.');
    };

    const renderAnkiSettings = () => {
      renderAnkiModelChoices();
      $('#ankiAllowDuplicate').prop('checked', ankiSettingsState?.allowDuplicate);
      renderAnkiDeckChoices();
      if (typeof renderAnkiAccountButton === 'function') renderAnkiAccountButton();
      renderAnkiRuntime();
    };

    const loadAnkiSettings = async () => {
      ankiSettingsState = await request('/api/anki-settings');
      await ankiModels.load(ankiSettingsState.modelName);
      renderAnkiSettings();
      return ankiSettingsState;
    };

    const submittedVisibleDecks = () => {
      if ($('#ankiDeckModeAll').prop('checked')) return [];
      const chosen = Array.from($('#ankiDeckChoices input:checked'), input => input.value);
      return chosen.length ? chosen : null;
    };

    const loadAnkiChoices = async () => {
      const { models, decks } = await request('/api/anki/decks');
      ankiModelSource = models || [];
      await ankiModels.load(ankiSettingsState?.modelName);
      renderAnkiModelChoices();
      ankiDeckSource = [...new Set(decks || [])].sort((a, b) => a.localeCompare(b));
      await ankiDecks.load();
      renderAnkiDeckChoices();
    };

    // The collection defaults are written as they are changed, so the panel is its own save button: the answer
    // lands in the status line beside the title, and the browser is told that the list it reads may have changed.
    // A change made while a write is in flight is not dropped — the whole form is read once more when it lands,
    // so the choice the user settled on last is the one the collection ends up with.
    let ankiSettingsSaving = false;
    let ankiSettingsAgain = false;
    const saveAnkiSettings = async () => {
      if (ankiSettingsSaving) { ankiSettingsAgain = true; return; }
      const visibleDecks = submittedVisibleDecks();
      // "Selected decks only" with nothing checked yet is an unfinished choice rather than a failed write, so it
      // says what is still missing and sends nothing.
      if (!visibleDecks) {
        setQuickSettingsStatus('Check at least one deck, or choose All decks.', 'warn');
        return;
      }
      const settings = {
        modelName: ankiModels.selectedId(),
        allowDuplicate: $('#ankiAllowDuplicate').prop('checked'),
        visibleDecks,
      };
      ankiSettingsSaving = true;
      setQuickSettingsStatus('Saving…', 'pending');
      try {
        await request('/api/anki-settings', { method: 'PUT', body: JSON.stringify(settings) });
        await loadAnkiSettings();
        setQuickSettingsStatus('Settings saved.', 'ok');
        $(document).trigger('anki-settings-changed');
      } catch (error) { setQuickSettingsStatus(error.message, 'error'); }
      finally {
        ankiSettingsSaving = false;
        if (ankiSettingsAgain) { ankiSettingsAgain = false; saveAnkiSettings(); }
      }
    };

    // Each control states itself before the write reads the form, which is why these two are on the elements: the
    // deck mode enables the deck choices, and the picker marks the note type, and both must have happened by the
    // time the form is read back.
    $('#ankiDeckModeAll, #ankiDeckModeSelected').on('change', event => {
      setAnkiDeckMode(event.target.id === 'ankiDeckModeAll');
      saveAnkiSettings();
    });
    $('#ankiDefaultModel').on('change', event => {
      ankiModels.select(event.currentTarget.value);
      saveAnkiSettings();
    });
    $('#ankiSettingsForm').on('change', '#ankiAllowDuplicate, #ankiDeckChoices input', saveAnkiSettings);

    return {
      getState: () => ankiSettingsState,
      getModelChoices: () => ankiModels.items(),
      setModelChoices: async models => {
        ankiModelSource = models || [];
        await ankiModels.load(ankiSettingsState?.modelName);
        renderAnkiModelChoices();
      },
      load: loadAnkiSettings,
      loadChoices: loadAnkiChoices,
      render: renderAnkiSettings,
      renderModelChoices: renderAnkiModelChoices,
      setPanelStatus: setQuickSettingsStatus,
    };
  };

  return { createAnkiDefaults };
});
