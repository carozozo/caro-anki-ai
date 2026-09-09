((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudyOptionsDialog = api;
})(globalThis, () => {
  // Study Options is Anki's own deck options: a preset that any number of decks can name, which is why it
  // is a studio of its own beside the decks that name it. Its form is drawn from the schema the API answers
  // with — every option, its label, its limits and its choices — so an option added to that contract is
  // drawn without a second layout here, and its values are read back by key and sent as the one patch the
  // API validates.
  const createStudyOptions = ({
    $, request, CaroUI, createDialog, armedConfirm, setStatus, onPresetsChanged,
  }) => {
    const { optionsHtml, pickerRow } = CaroUI.fields;
    const { set: setSystemMessage } = CaroUI.status;
    const { escapeAttr, escapeHtml } = CaroUI.text;
    const $form = $('#ankiStudyOptionFields');
    let fields = [];
    let presets = [];
    let model = null;
    let saving = false;

    const status = (text, kind = '') => setSystemMessage($('#ankiStudyOptionStatus'), text, kind);
    // Closing drops the preset on screen, so the next opening re-reads the collection instead of saving a
    // form that was filled before the values changed in Anki itself.
    const dialog = createDialog({
      selector: '#ankiStudyOptionsDialog',
      onClose: () => {
        model = null;
        fields = [];
        $form.empty();
      },
    });
    const manager = CaroUI.entityManager({
      // One read fills the picker, the schema that draws the form, and the preset every deck in the
      // collection names, so this dialog and Deck Studio's selector can never show different lists.
      list: async () => {
        const answer = await request('/api/anki/study-options');
        fields = answer.fields;
        presets = answer.presets;
        return answer.presets;
      },
      create: async payload => (await request('/api/anki/study-options', {
        method: 'POST', body: JSON.stringify(payload),
      })).preset,
      rename: async (id, name) => (await request(`/api/anki/study-options/${id}`, {
        method: 'PUT', body: JSON.stringify({ name }),
      })).preset,
      remove: id => request(`/api/anki/study-options/${id}`, { method: 'DELETE' }),
      // Anki's own preset is the fallback for a deck that names none, so it is offered like any other preset
      // and never renamed or removed — the bridge refuses both, which is what actually protects it.
      canRename: preset => Boolean(preset) && preset.removable,
      canDelete: preset => Boolean(preset) && preset.removable,
    });

    const deckStudyOption = deck => presets.find(preset => (preset.decks || []).includes(deck)) ?? null;
    const loadPresets = () => manager.load();
    // A preset's identity is its own id, and its name is what Anki renames.
    const valueOf = preset => preset.id;
    const labelOf = preset => preset.name;
    // One option is one field: a checkbox, a select of the choices the schema names, or a number — except a
    // step list, which is written as text ("1m 10m"). The limits the schema carries become the input's own.
    const inputAttributes = field => [
      `type="${field.kind === 'steps' ? 'text' : 'number'}"`,
      field.placeholder === undefined ? '' : `placeholder="${escapeAttr(field.placeholder)}"`,
      field.min === undefined ? '' : `min="${field.min}" max="${field.max}"`,
      field.step === undefined ? '' : `step="${field.step}"`,
    ].filter(Boolean).join(' ');

    const renderField = field => {
      const key = escapeAttr(field.key);
      if (field.kind === 'bool') {
        return `<label class="anki-setting-check">
          <input type="checkbox" data-option-key="${key}" id="ankiStudyOption-${key}">
          <span>${escapeHtml(field.label)}</span></label>`;
      }
      const control = field.kind === 'choice'
        ? `<select class="field" data-option-key="${key}" id="ankiStudyOption-${key}">${
          optionsHtml(field.choices)}</select>`
        : `<input class="field" data-option-key="${key}" id="ankiStudyOption-${key}"
          ${inputAttributes(field)}>`;
      return `<label class="dialog-field" for="ankiStudyOption-${key}">
        <span class="dialog-label">${escapeHtml(field.label)}</span>${control}</label>`;
    };

    const renderFields = () => $form.html(fields
      .map(group => `<section class="anki-entity-section">
        <div class="anki-entity-section-head"><span class="eyebrow">${escapeHtml(group.title)}</span></div>
        <div class="anki-study-option-grid">${group.fields.map(renderField).join('')}</div>
      </section>`).join(''));

    // The form is read by key, so an option the schema adds is sent without a second list of names, and one
    // value the API rejects comes back as its own sentence in the status line. Only the options the user
    // actually changed are read, because a preset can hold a value this API's guard does not accept (a legacy
    // one Anki never clamped) and an untouched option must never refuse a save the user did make.
    const readForm = () => {
      const stored = model?.settings ?? {};
      const changed = {};
      $form.find('[data-option-key]').each((_, control) => {
        const $control = $(control);
        const key = $control.data('optionKey');
        const isBool = $control.is(':checkbox');
        const value = isBool ? $control.prop('checked') : $control.val();
        const unchanged = isBool ? Boolean(stored[key]) === value : String(stored[key] ?? '') === value;
        if (!unchanged) changed[key] = value;
      });
      return changed;
    };

    // One sentence about the preset on screen, in place of a help line per mode: the list and the rename form
    // both describe the preset that is open, and only the form for a new one has nothing to describe yet.
    const renderHelp = mode => {
      const preset = model;
      const decks = preset?.decks || [];
      $('#ankiStudyOptionHelp').text(mode === 'create'
        ? 'A new preset starts as a copy of the one on screen, and no deck changes until one names it.'
        : !preset ? 'Loading the study options of this collection…'
        : !preset.removable
          ? 'Anki schedules a deck with the study options it names, and "Default" is what a deck that names '
            + 'none uses, so it can be edited but not renamed or deleted.'
          : decks.length
            ? `${decks.length} deck${decks.length === 1 ? '' : 's'} is scheduled with these study options: `
              + `${decks.join(', ')}.`
            : 'No deck is scheduled with these study options yet.');
    };

    const renderModel = ({ values = true } = {}) => {
      const preset = model;
      const ready = !saving;
      // The row paints the list and the two forms, so this only reads the preset for the schema below.
      picker.render();
      $('#ankiDeleteStudyOption').prop('disabled', !(ready && manager.canDelete()));
      $form.find('input, select').prop('disabled', !ready);
      if (!values) return;
      fields.forEach(group => group.fields.forEach(field => {
        const $control = $(`#ankiStudyOption-${field.key}`);
        const value = preset?.settings[field.key];
        if (field.kind === 'bool') $control.prop('checked', Boolean(value));
        else $control.val(value ?? '');
      }));
    };

    const setSaveControls = disabled => {
      $('#ankiStudyOptionSelect, #ankiStudyOptionConfirm, #ankiStudyOptionReturn').prop('disabled', disabled);
      $('#ankiDeleteStudyOption').prop('disabled', disabled || !manager.canDelete());
      $form.find('input, select').prop('disabled', disabled);
    };

    // The preset on screen is read on its own, and the schema that draws the form travels in the same answer.
    const loadModel = async presetId => {
      model = null;
      if (!presetId) return renderModel();
      const answer = await request(`/api/anki/study-options?presetId=${encodeURIComponent(presetId)}`);
      fields = answer.fields;
      model = answer.preset;
      renderFields();
      return renderModel();
    };

    const select = async presetId => {
      status('Loading study options…', 'pending');
      try {
        await loadModel(presetId);
        status('', '');
      } catch (error) {
        status(error.message, 'error');
      }
    };

    const open = async preferredId => {
      dialog.open();
      status('Loading study options…', 'pending');
      try {
        await manager.load(preferredId);
        await loadModel(manager.selectedId());
        status('', '');
      } catch (error) {
        status(error.message, 'error');
      }
    };

    const withSave = async (work, success, {
      onSaved, reloadModel = true, render = true, notifyPresets = true, report = true,
    } = {}) => {
      if (saving) return;
      saving = true;
      let saved = false;
      if (render) renderModel({ values: reloadModel });
      else setSaveControls(true);
      if (report) status('Saving…', 'pending');
      try {
        const result = await work();
        if (reloadModel) await loadModel(manager.selectedId());
        else model = result.preset ?? result;
        saved = true;
        // Deck Studio reads the same list, so it is redrawn from the answer that was just written instead of
        // keeping a preset this dialog renamed or removed out of date.
        if (notifyPresets) onPresetsChanged();
        if (report) {
          status(success, 'ok');
          setStatus(success, 'ok');
        }
        // A form leaves only once the write behind it has landed, so a failed save keeps the name on screen
        // to correct instead of dropping it.
        onSaved?.();
      } catch (error) {
        status(error.message, 'error');
      } finally {
        saving = false;
        if (render || !saved) renderModel({ values: reloadModel || !saved });
        else setSaveControls(false);
      }
    };

    // The preset list is one control that becomes the list, the open preset's name, or a name for a new one,
    // exactly as in the studios. Two things this row has that they do not: a preset's own form, drawn from the
    // schema the API answers, which a pick has to re-read; and a new preset that starts as a copy of the one on
    // screen rather than empty, which is why the create step passes the selected id along.
    const picker = pickerRow({
      manager,
      ids: {
        select: '#ankiStudyOptionSelect', rename: '#ankiStudyOptionName', create: '#ankiNewStudyOptionName',
        confirm: '#ankiStudyOptionConfirm', back: '#ankiStudyOptionReturn', remove: '#ankiDeleteStudyOption',
      },
      sentinel: '- New Study Options -',
      entity: 'study options',
      // The noun takes no article, which is the one label the row builds without an entity to name.
      article: '',
      option: { value: valueOf, label: labelOf },
      isReady: () => !saving,
      run: withSave,
      create: name => manager.create({ name, cloneFrom: manager.selectedId() }),
      messages: {
        created: name => `Created study options ${name}`,
        renamed: (from, name) => `Renamed study options ${from} to ${name}`,
      },
      // Choosing a preset is what reads its form, which is the second request this dialog makes.
      onPick: () => select(manager.selectedId()),
      onMode: mode => renderHelp(mode),
    });

    // Every committed field change writes its patch immediately. The PUT returns the complete updated preset,
    // so it becomes the next comparison baseline without repainting surrounding UI; failures still report.
    $form.on('change', '[data-option-key]', () => {
      const preset = model;
      if (!preset || saving) return;
      const settings = readForm();
      if (!Object.keys(settings).length) return;
      withSave(() => request(`/api/anki/study-options/${preset.id}`, {
        method: 'PUT', body: JSON.stringify({ settings }),
      }), `Saved the study options of ${preset.name}`, {
        reloadModel: false, render: false, notifyPresets: false,
      });
    });
    const deleteConfirm = armedConfirm(() => {
      const preset = model;
      if (!preset || saving || !manager.canDelete()) return undefined;
      return withSave(() => manager.remove(preset.id),
        `Deleted study options ${preset.name} — its decks moved to Default`);
    });
    $('#ankiDeleteStudyOption').on('click', event => {
      if (saving || !manager.canDelete()) return;
      deleteConfirm.handle(event,
        `Click again to delete "${model?.name}" — its decks move to Default`);
    });

    return { open, deckStudyOption, loadPresets, presets: () => presets };
  };

  return { createStudyOptions };
});
