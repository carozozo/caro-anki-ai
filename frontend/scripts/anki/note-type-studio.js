((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteTypeStudio = api;
})(globalThis, () => {
  // Note Type Studio is Deck Studio's shape over note types, driven by the same entity manager: its items are
  // the collection's own summaries and a model's identity is its name, which is also what Anki renames. The
  // manager deliberately holds summaries, so `model` stays the one note type whose fields and card templates
  // are on screen, read on demand.
  //
  // The dialog is one note type behind two panels — its fields and its card templates — because a card template
  // names the fields it renders, so the two halves of the same note type belong on the same screen.
  const createNoteTypeStudio = ({
    $, request, CaroUI, createDialog, armedConfirm, setStatus, getSettings, selectedModelName, refreshSidebars,
  }) => {
    const { fillOptions, optionsHtml, pickerRow } = CaroUI.fields;
    const { bindEnterToClick } = CaroUI.keyboard;
    const { set: setSystemMessage } = CaroUI.status;
    const { escapeAttr } = CaroUI.text;
    const { iconButton } = CaroUI.icons;
    const dialog = createDialog({ selector: '#ankiNoteTypeDialog' });
    // A field saves as it is changed, and a rename and a settings toggle are two separate Anki writes, so the
    // writes queue behind each other instead of racing: `busy` is what the moment-to-moment controls ask while
    // one is queued or in flight, so a delete can never run between two halves of the same row's edit.
    let writing = Promise.resolve();
    let busy = 0;
    let model = null;
    let templateSource = 'front';
    let templateDraft = { front: '', back: '', styling: '' };
    let templateSaveTimer = null;
    // The two picker rows are the shared three-in-one control; they are built once the queued write they sit on
    // is defined, and every render below asks them for the shape the mode they are in has.
    let picker = null;
    let templatePicker = null;
    // The one field whose settings are unfolded. A field is identified by its name, so a rename carries the row
    // over, and only one row is ever open: opening a second one folds the first.
    const settingsOpen = new Set();

    const status = (text, kind = '') => setSystemMessage($('#ankiNoteTypeStatus'), text, kind);
    const url = name => `/api/anki/models/${encodeURIComponent(name)}`;

    const manager = CaroUI.entityManager({
      id: item => item.name,
      labelOf: item => item.name,
      list: async () => (await request('/api/anki/models')).models,
      create: async ({ name, fields, templates, styling }) =>
        (await request('/api/anki/models', {
          method: 'POST', body: JSON.stringify({ name, fields, templates, styling }),
        })).model,
      rename: async (from, name) => (await request(url(from), {
        method: 'PUT', body: JSON.stringify({ name }),
      })).model,
      remove: name => request(url(name), { method: 'DELETE' }),
    });

    // A card template is a child of the note type on screen rather than an entity in a list of its own, so the
    // card row's manager reads the loaded model and its writes name that note type's templates endpoint. Every
    // card write answers with the note type as Anki now holds it — the name it was given included, which Anki
    // stores exactly as sent — so the answer is adopted here instead of a second read being made: re-reading
    // reloads the row's own list and moves its selection back onto the first card, which is not the one the user
    // just renamed.
    const adoptTemplate = (answer, name) => { model = answer.model; return { name }; };
    const templateUrl = name => `${url(model.name)}/templates/${encodeURIComponent(name)}`;
    const templateManager = CaroUI.entityManager({
      id: item => item.name,
      labelOf: item => item.name,
      list: async () => model?.templates || [],
      create: async ({ name, front }) => adoptTemplate(await request(`${url(model.name)}/templates`, {
        method: 'POST', body: JSON.stringify({ name, front, back: '{{FrontSide}}<hr id=answer>' }),
      }), name),
      rename: async (from, name) => adoptTemplate(
        await request(templateUrl(from), { method: 'PUT', body: JSON.stringify({ name }) }), name),
      remove: async name => { model = (await request(templateUrl(name), { method: 'DELETE' })).model; },
      canRename: () => Boolean(model),
      canDelete: () => (model?.templates.length || 0) > 1,
    });
    // The card on screen is the row's own selection, so the two can never disagree about which one is open.
    const currentTemplate = () => model?.templates.find(item => item.name === templateManager.selectedId());

    // A field's settings are Anki's own: the font and size its text is written in, and the switches that decide
    // how the field behaves in the editor and in the reviewer.
    const fieldToggle = (key, field, label) => `
      <label class="anki-setting-check">
        <input type="checkbox" data-field-setting="${key}"${field[key] ? ' checked' : ''}>
        ${label}
      </label>`;

    // The folded row states nothing about itself: every setting it holds is one click away, and a line of state
    // text beside each name made the field set read as a report instead of as the list Anki itself shows.
    const fieldSettings = field => `
      <div class="anki-field-settings">
        <label class="dialog-field">
          <span class="dialog-label">Font</span>
          <input class="field" data-field-setting="font" value="${escapeAttr(field.font)}">
        </label>
        <label class="dialog-field">
          <span class="dialog-label">Size</span>
          <input class="field anki-field-narrow" type="number" min="1" max="200"
            data-field-setting="size" value="${escapeAttr(field.size)}">
        </label>
        <div class="anki-field-toggles">
          ${fieldToggle('rtl', field, 'Right to left')}
          ${fieldToggle('sticky', field, 'Sticky')}
          ${fieldToggle('collapsed', field, 'Collapsed in the editor')}
          ${fieldToggle('htmlEditor', field, 'Use HTML editor by default')}
        </div>
        <label class="dialog-field anki-field-description">
          <span class="dialog-label">Description</span>
          <input class="field" data-field-setting="description" value="${escapeAttr(field.description)}"
            placeholder="Hint the note editor shows above this field">
        </label>
      </div>`;

    // Anki sorts a note by exactly one of its fields, so the choice is a radio of one group down the rows —
    // a mark on the row it names rather than a picker in the header that repeats every name.
    const sortFieldName = () => model?.fields[model?.sortFieldIndex ?? 0]?.name;

    const sortRadio = (field, isSort, index) => `
      <input type="radio" class="anki-field-sort" name="ankiNoteTypeSortField"
        value="${escapeAttr(field.name)}" aria-label="Sort field ${index + 1}: ${escapeAttr(field.name)}"
        title="Sort notes by this field"${isSort ? ' checked' : ''}>`;

    const fieldRow = (field, index, fields, sortField) => `
      <div class="anki-schema-row" data-field-name="${escapeAttr(field.name)}">
        <div class="anki-schema-row-main">
          ${sortRadio(field, field.name === sortField, index)}
          <input class="field anki-note-type-field-name" value="${escapeAttr(field.name)}"
            aria-label="Field ${index + 1} name">
          ${iconButton({
            className: 'anki-note-type-field-settings icon-button-sm',
            icon: 'sliders', label: `${field.name} settings`,
            attributes: `aria-expanded="${settingsOpen.has(field.name)}"`,
          })}
          ${iconButton({
            className: 'anki-note-type-field-move icon-button-sm',
            icon: 'arrow-up', label: `Move ${field.name} up`,
            attributes: `data-index="${index - 1}" ${index ? '' : 'disabled'}`,
          })}
          ${iconButton({
            className: 'anki-note-type-field-move icon-button-sm',
            icon: 'arrow-down', label: `Move ${field.name} down`,
            attributes: `data-index="${index + 1}" ${index + 1 < fields.length ? '' : 'disabled'}`,
          })}
          ${iconButton({
            className: 'anki-note-type-field-delete icon-button-sm', variant: 'delete',
            icon: 'trash', label: `Delete ${field.name}`,
            attributes: fields.length === 1 ? 'disabled' : '',
          })}
        </div>
        ${settingsOpen.has(field.name) ? fieldSettings(field) : ''}
      </div>`;

    const renderFields = () => {
      const fields = model?.fields || [];
      const sortField = sortFieldName();
      $('#ankiNoteTypeFields').html(fields.map((field, index) => fieldRow(field, index, fields, sortField)).join(''));
    };

    // One row is replaced in place where only its own state changed — its unfolded settings, its sort mark — so
    // the rows around it, and any caret or scroll position they hold, stay exactly where they were. A name the
    // model no longer has (the row was renamed or deleted) falls back to the whole list, because the row the
    // caller named is not there to be found.
    const paintFieldRow = name => {
      const fields = model?.fields || [];
      const index = fields.findIndex(field => field.name === name);
      const $row = $('#ankiNoteTypeFields .anki-schema-row')
        .filter((_, row) => row.dataset.fieldName === name);
      if (index < 0 || !$row.length) {
        renderFields();
        return;
      }
      $row.replaceWith(fieldRow(fields[index], index, fields, sortFieldName()));
    };

    const frontFor = field => `{{${field}}}`;

    // A new card template has to name a field Anki knows, or Anki refuses it outright ("Expected to find a
    // field replacement on the front of the card template"), and its front has to differ from every other
    // card's, or Anki refuses it as identical. So the fields are offered as the front text itself, starting
    // on the first one no card uses yet — the model holds each field as its settings, so what is offered is
    // its name, which is also what the value has to be.
    const renderNewTemplateField = () => {
      const fields = (model?.fields || []).map(field => field.name);
      const used = new Set((model?.templates || []).map(template => (template.front || '').trim()));
      const previous = $('#ankiNewNoteTypeTemplateField').val();
      const chosen = fields.includes(previous)
        ? previous : fields.find(field => !used.has(frontFor(field)));
      fillOptions($('#ankiNewNoteTypeTemplateField'), optionsHtml(fields, { label: frontFor }))
        .val(chosen || fields[0] || '');
    };

    // The row paints the card list and the name it renames; a paint by its own means: the select the user chose
    // from, the field the save button reads, and the styling every card shares. The name input belongs to the
    // row's rename step, so painting it here would overwrite a rename the user is still typing.
    const templateSourceLabel = {
      front: 'Front template', back: 'Back template', styling: 'Styling (shared by every card)',
    };

    const captureTemplateSource = () => {
      templateDraft[templateSource] = $('#ankiNoteTypeTemplateSource').val();
    };

    const renderTemplateSource = () => {
      $('.anki-template-source-label').each((_, label) => {
        const selected = $(label).data('template-source') === templateSource;
        $(label).toggleClass('is-active', selected).attr('aria-pressed', String(selected));
      });
      $('#ankiNoteTypeTemplateSourceLabel').text(templateSourceLabel[templateSource]);
      $('#ankiNoteTypeTemplateSource').val(templateDraft[templateSource]);
    };

    const selectTemplateSource = source => {
      captureTemplateSource();
      templateSource = source;
      renderTemplateSource();
    };

    const renderTemplate = () => {
      const template = currentTemplate();
      templateDraft = { front: template?.front || '', back: template?.back || '', styling: model?.styling || '' };
      renderTemplateSource();
    };

    // Three panels, three paints, and one full paint for a note type that has just arrived. A write names the one
    // panel its own answer changed instead of repainting the dialog: the row that holds the name and the list, the
    // field rows, or the card on screen — and nothing at all for a write whose own control already shows what was
    // saved, which is what keeps a save from moving the control the user is typing in.
    const paintShell = () => {
      picker.render();
      $('#ankiNoteTypeName').val(model?.name || '');
      $('#ankiDeleteNoteType').prop('disabled', !model || !manager.canDelete());
    };

    // A field write changes both the rows and the list of fields a new card can name, so the two are painted
    // together — they are the same fact about the model.
    const paintFields = () => {
      renderFields();
      renderNewTemplateField();
    };

    const paintTemplate = () => {
      templatePicker.render();
      renderTemplate();
    };

    const render = () => {
      paintShell();
      paintFields();
      paintTemplate();
    };

    const panels = { all: render, fields: paintFields, none: () => {}, template: paintTemplate };

    // The model on screen and the card row are dropped together: a render after this shows the list alone, which
    // is what a load paints while its detail request is still in flight.
    const forgetModel = async () => {
      model = null;
      await templateManager.load('');
    };

    // Reads the note type into `model` and the card row without painting, so a write re-reads its own entity and
    // then repaints exactly the panel that read changed.
    const readModel = async name => {
      await forgetModel();
      if (!name) return;
      model = (await request(url(name))).model;
      await templateManager.load(model.templates[0]?.name || '');
    };

    // A write that answers with the whole note type becomes the model on screen, so the panel it repaints is
    // painted from the saved state without paying for a second read. An answer for a note type the user has since
    // left is dropped, because it is no longer the one on screen.
    const adoptModel = next => {
      if (next && model && next.name === model.name) model = next;
      return next;
    };

    const loadModel = async name => {
      // The sentinel is never loaded: it only leads to the form that makes the first note type, and this is
      // only ever handed a real name or none.
      if (name) manager.select(name);
      // Which field is unfolded belongs to the note type it was unfolded in, so landing on another one starts
      // folded.
      if (model?.name !== name) settingsOpen.clear();
      await forgetModel();
      render();
      if (!name) return;
      status('Loading note type…', 'pending');
      try {
        await readModel(name);
        render();
        status('');
      } catch (error) {
        status(error.message, 'error');
      }
    };

    const load = async preferredName => {
      await manager.load(preferredName);
      await loadModel(manager.selectedId());
    };

    // A write that changed which note types exist, renamed the open one or deleted it re-reads the list and the
    // open note type and repaints the whole dialog; the sidebars drawing the same collection follow.
    const refresh = async name => {
      await manager.load(name ?? model?.name);
      const target = manager.selectedId();
      if (model?.name !== target) settingsOpen.clear();
      await readModel(target);
      render();
      await refreshSidebars();
    };

    const open = async () => {
      dialog.open();
      status('Loading note types…', 'pending');
      try {
        await load(selectedModelName() ?? getSettings()?.modelName);
      } catch (error) {
        status(error.message, 'error');
      }
    };

    // Every write in this dialog goes through here, one at a time and in the order it was asked for: a rename
    // that landed without the settings the user changed next to it would leave the row half applied. The status
    // line is written beside the title, so it is still where it was when the answer arrives. `reload` is what is
    // read back — the whole dialog for a note type that appeared, was renamed or was deleted, the list alone for a
    // count the row's own label shows, or nothing for a write whose own control already shows the saved value —
    // and `panel` is the one panel that read repaints, so a run of settings can be typed into without the row
    // moving under the cursor. `onSaved` runs only once the write has landed, so a form that steps aside for its
    // own success stays open when it fails and the user can correct it.
    const withSave = (work, success, { reload = 'refresh', panel = 'all', onSaved } = {}) => {
      busy += 1;
      writing = writing.then(async () => {
        status('Saving…', 'pending');
        try {
          const saved = await work();
          const name = saved?.name ?? model?.name;
          // A full reload re-reads the list and the open note type, so it paints both panels itself; every
          // lighter read leaves the painting to the panel the write named.
          if (reload === 'refresh') await refresh(name);
          else {
            // The list is re-read for a count the shell's own label shows, so the shell is part of what that
            // read repaints.
            if (reload === 'list') {
              await manager.load(name);
              paintShell();
            }
            panels[panel]();
          }
          status(success, 'ok');
          setStatus(success, 'ok');
          onSaved?.();
        } catch (error) {
          status(error.message, 'error');
        } finally {
          busy -= 1;
          picker?.syncReady();
          templatePicker?.syncReady();
        }
      });
      return writing;
    };

    // A card write answers with the note type as Anki now holds it, and the card row stores that answer itself, so
    // the only list left to re-read is the note type list the shell's own label counts; the card panel is what
    // repaints, from that stored answer. An auto-save passes `repaint: false`: its answer is older than what the
    // editor holds, and repainting the card from it would overwrite text typed after the save was snapshotted.
    const templateRun = (work, success, { onSaved, repaint = true, reloadList = true } = {}) => withSave(
      async () => {
        await work();
        return { name: model?.name };
      },
      success,
      { panel: repaint ? 'template' : 'none', reload: reloadList ? 'list' : 'none', onSaved });

    // The fields and the card templates are two panels of one dialog, so switching moves the panel underneath and
    // leaves the note type, the status line and the tab strip where they were.
    const selectSection = section => {
      $('.anki-note-type-tab').each((_, tab) => {
        const selected = $(tab).data('note-type-section') === section;
        $(tab).toggleClass('is-active', selected)
          .attr({ 'aria-selected': String(selected), tabindex: selected ? 0 : -1 });
      });
      $('.anki-note-type-panel').each((_, panel) =>
        $(panel).prop('hidden', panel.id !== `ankiNoteType${section[0].toUpperCase()}${section.slice(1)}Panel`));
    };

    const saveFieldName = $row => {
      const field = $row.data('field-name');
      const name = $row.find('.anki-note-type-field-name').val().trim();
      if (!model || !field || !name || name === field) return;
      withSave(async () => {
        const saved = await request(`${url(model.name)}/fields/${encodeURIComponent(field)}`, {
          method: 'PUT', body: JSON.stringify({ name }),
        });
        // The row keeps its unfolded settings under the name the field now has.
        if (settingsOpen.delete(field)) settingsOpen.add(name);
        return adoptModel(saved.model);
      }, `Renamed field to ${name}`, { reload: 'none', panel: 'fields' });
    };

    // A settings control writes the Anki key it names, with the value its own type carries: a switch is a boolean,
    // a font size is a number, and the rest is the text as typed.
    const fieldSettingValue = element => element.type === 'checkbox' ? element.checked
      : element.type === 'number' ? Number(element.value) : element.value.trim();

    // A setting is written on its own and paints nothing: the answer is folded back into the model row it belongs
    // to, but the control that wrote it already shows that value, so a repaint could only take the control’s own
    // focus or its scroll position away. A run of settings can therefore be typed straight through.
    const saveFieldSetting = element => {
      const $row = $(element).closest('.anki-schema-row');
      const field = model?.fields.find(item => item.name === $row.data('field-name'));
      if (!field) return;
      const key = element.dataset.fieldSetting;
      withSave(async () => {
        const { model: saved } = await request(`${url(model.name)}/fields/${encodeURIComponent(field.name)}`, {
          method: 'PUT', body: JSON.stringify({ [key]: fieldSettingValue(element) }),
        });
        Object.assign(field, saved.fields.find(item => item.name === field.name) || {});
        return saved;
      }, `Saved ${field.name}`, { reload: 'none', panel: 'none' });
    };

    // The row is the shared three-in-one picker — the collection's note types, the open one's name, a name for
    // a new one — and the studio's queued writes are what sits behind it. A new note type starts on two fields
    // and one card that names them, because Anki refuses a note type whose card names no field.
    picker = pickerRow({
      manager,
      ids: {
        select: '#ankiNoteTypeSelect', rename: '#ankiNoteTypeName', create: '#ankiNewNoteTypeName',
        confirm: '#ankiNoteTypeConfirm', back: '#ankiNoteTypeReturn', remove: '#ankiDeleteNoteType',
      },
      sentinel: '- New Note Type -',
      entity: 'note type',
      option: {
        value: item => item.name,
        label: item => `${item.name} · ${item.fieldCount} fields · ${item.templateCount} cards`,
      },
      isReady: () => !busy,
      run: withSave,
      create: name => manager.create({
        name,
        fields: ['Front', 'Back'],
        templates: [{ name: 'Card 1', front: '{{Front}}', back: '{{FrontSide}}<hr id=answer>{{Back}}' }],
        styling: '.card {}',
      }),
      onPick: loadModel,
      messages: {
        created: name => `Created ${name}`,
        renamed: (from, name) => `Renamed note type to ${name}`,
      },
    });

    // The card list is the same row over the templates of the note type on screen.
    templatePicker = pickerRow({
      manager: templateManager,
      ids: {
        select: '#ankiNoteTypeTemplateSelect', rename: '#ankiNoteTypeTemplateName',
        create: '#ankiNewNoteTypeTemplate', confirm: '#ankiNoteTypeTemplateConfirm',
        back: '#ankiNoteTypeTemplateReturn', remove: '#ankiDeleteNoteTypeTemplate',
      },
      sentinel: '- New Card -',
      entity: 'card template',
      option: { value: item => item.name, label: item => item.name },
      isReady: () => !busy && Boolean(model),
      run: templateRun,
      // The same field on two cards is refused here, with the sentence that says which card already has it,
      // rather than travelling to Anki for that answer.
      create: async name => {
        const front = frontFor($('#ankiNewNoteTypeTemplateField').val());
        const clash = (model?.templates || []).find(template => (template.front || '').trim() === front);
        if (clash) throw new Error(`${clash.name} already has ${front} as its front; pick a different field.`);
        return templateManager.create({ name, front });
      },
      onPick: renderTemplate,
      // The field picker belongs to the create step alone — a new card starts on a field, because Anki refuses a
      // card whose front names none — so it is shown only there, and named as part of that form so choosing one
      // is not read as leaving the row.
      stay: ['#ankiNewNoteTypeTemplateField'],
      onMode: mode => {
        $('#ankiNewNoteTypeTemplateField').prop('hidden', mode !== 'create');
        $('#ankiDeleteNoteTypeTemplate').prop('disabled', !templateManager.canDelete());
        if (mode === 'create') renderNewTemplateField();
      },
      messages: {
        created: name => `Added card ${name}`,
        renamed: (from, name) => `Renamed card ${from} to ${name}`,
      },
    });

    bindEnterToClick($('#ankiNewNoteTypeField'), $('#ankiAddNoteTypeField'));
    // A rename is a commit, not a keystroke: it saves when the row is left or when Enter is pressed, and never on
    // the way to a name the user is still typing.
    $('#ankiNoteTypeFields')
      .on('keydown', '.anki-note-type-field-name', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        saveFieldName($(event.currentTarget).closest('.anki-schema-row'));
      })
      .on('change', '.anki-note-type-field-name', event =>
        saveFieldName($(event.currentTarget).closest('.anki-schema-row')));
    const deleteConfirm = armedConfirm(() => {
      const current = model;
      if (!current || busy) return undefined;
      return withSave(() => manager.remove(current.name), `Deleted ${current.name}`);
    });
    $('#ankiDeleteNoteType').on('click', event => {
      if (busy || !model || !manager.canDelete()) return;
      deleteConfirm.handle(event, `Click again to delete "${model.name}" and its notes`);
    });
    // A field and a card template are two more deletes inside this studio, so they arm the same way; the row
    // button carries the field it belongs to, which is why the name is read back off the button.
    const deleteFieldConfirm = armedConfirm($button => {
      const field = $button.closest('.anki-schema-row').data('field-name');
      if (!field || busy) return undefined;
      return withSave(async () => {
        const saved = await request(`${url(model.name)}/fields/${encodeURIComponent(field)}`, { method: 'DELETE' });
        settingsOpen.delete(field);
        return adoptModel(saved.model);
      }, `Deleted field ${field}`, { reload: 'list', panel: 'fields' });
    });
    const deleteTemplateConfirm = armedConfirm(() => {
      const name = templateManager.selectedId();
      if (!name || busy) return undefined;
      return templateRun(() => templateManager.remove(name), `Deleted card ${name}`);
    });
    $('#ankiAddNoteTypeField').on('click', () => {
      const name = $('#ankiNewNoteTypeField').val().trim();
      if (!name || busy) return;
      withSave(async () => adoptModel((await request(`${url(model.name)}/fields`, {
        method: 'POST', body: JSON.stringify({ name }),
      })).model), `Added field ${name}`, { reload: 'list', panel: 'fields' });
      $('#ankiNewNoteTypeField').val('');
    });
    // The sliders unfold a field's own settings under its row, and only one row is unfolded at a time: Anki's own
    // Fields screen shows one field's settings pane, and a stack of them would push the rows underneath out of the
    // list. Only the rows whose state actually changed are painted — the one folding away and the one unfolding —
    // because rebuilding the list would take the caret out of a name the user is still typing.
    const toggleFieldSettings = name => {
      const folding = [...settingsOpen];
      const opening = !settingsOpen.has(name);
      settingsOpen.clear();
      if (opening) settingsOpen.add(name);
      [...new Set([...folding, name])].forEach(paintFieldRow);
    };
    $('#ankiNoteTypeFields').on('click', '.anki-note-type-field-settings', event => {
      const field = $(event.currentTarget).closest('.anki-schema-row').data('field-name');
      if (field) toggleFieldSettings(field);
    }).on('change', '[data-field-setting]', event => saveFieldSetting(event.currentTarget))
      .on('change', '.anki-field-sort', event => {
        const name = event.currentTarget.value;
        if (model && name) saveSortField(name);
      })
      .on('click', '.anki-note-type-field-move', event => {
      const field = $(event.currentTarget).closest('.anki-schema-row').data('field-name');
      const index = Number($(event.currentTarget).data('index'));
      withSave(async () => adoptModel((await request(`${url(model.name)}/fields/${encodeURIComponent(field)}`, {
        method: 'PUT', body: JSON.stringify({ index }),
      })).model), 'Reordered fields', { reload: 'none', panel: 'fields' });
    }).on('click', '.anki-note-type-field-delete', event => {
      const field = $(event.currentTarget).closest('.anki-schema-row').data('field-name');
      if (!field || busy) return;
      deleteFieldConfirm.handle(event, `Click again to delete field "${field}" and all of its content`);
    });
    const saveTemplate = ({ modelName, name, draft }) => {
      if (!name || !modelName) return;
      templateRun(() => request(`${url(modelName)}/templates/${encodeURIComponent(name)}`, {
        method: 'PUT', body: JSON.stringify(draft),
      }).then(answer => adoptModel(answer.model)), `Saved card ${name}`, { repaint: false, reloadList: false });
    };

    const scheduleTemplateSave = () => {
      const name = templateManager.selectedId();
      if (!name || !model) return;
      const pending = { modelName: model.name, name, draft: { ...templateDraft } };
      clearTimeout(templateSaveTimer);
      templateSaveTimer = setTimeout(() => saveTemplate(pending), 500);
    };

    $('#ankiNoteTypeTemplateSource').on('input', event => {
      templateDraft[templateSource] = event.currentTarget.value;
      scheduleTemplateSave();
    });
    $('.anki-template-source-label').on('click', event =>
      selectTemplateSource($(event.currentTarget).data('template-source')));
    $('#ankiDeleteNoteTypeTemplate').on('click', event => {
      const name = templateManager.selectedId();
      if (busy || !name) return;
      deleteTemplateConfirm.handle(event, `Click again to delete card template "${name}"`);
    });
    // The sort field is the one note type setting that belongs to no single row, so it saves from the markup of the
    // row it names. A write that lands leaves the mark where the user put it and paints nothing; a refused write
    // leaves the model where it was, so the one row the click marked is repainted back onto it — the row that was
    // marked before still is, and it is not the one that moved.
    const saveSortField = name => withSave(() => request(url(model.name), {
      method: 'PUT', body: JSON.stringify({ sortField: name }),
    }).then(answer => adoptModel(answer.model)), `Sorts notes by ${name}`, { reload: 'none', panel: 'none' })
      .then(() => {
        if (sortFieldName() !== name) paintFieldRow(name);
      });
    $('.anki-note-type-tab').on('click', event =>
      selectSection($(event.currentTarget).data('note-type-section')));
    $('.anki-note-type-tab').on('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const $tabs = $('.anki-note-type-tab');
      const index = $tabs.index(event.currentTarget);
      const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + $tabs.length) % $tabs.length;
      $tabs.eq(next).trigger('click').trigger('focus');
    });

    return { open, refresh, load };
  };

  return { createNoteTypeStudio };
});
