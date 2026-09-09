((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroSettingsDialogs = api;
})(globalThis, () => {
  const displayLibraryName = entry => entry.type === 'instructions'
    ? entry.name.replace(/\.md$/i, '') : entry.name;

  const normalizeLibraryName = (type, name) => {
    const value = String(name ?? '').trim();
    if (type === 'instructions') return value && !/\.md$/i.test(value) ? `${value}.md` : value;
    return value.replace(/^\//, '').toLowerCase();
  };

  const sameLibraryEntry = (left, right) => left.type === right.type && left.name === right.name;

  const createSettingsDialogs = ({
    $,
    CaroUI,
    config,
    NoteShortcuts,
    request,
    state,
    setStatus,
    renderAnkiAccountButton,
    clearPendingChat,
    writeBrowserView,
    getAgentSettings,
    setAgentSettings,
    applyAgentAvailability,
  }) => {
    const { create: createDialog } = CaroUI.dialogs;
    const { set: setSystemMessage } = CaroUI.status;
    const { armed: armedConfirm } = CaroUI.confirm;
    const { icon } = CaroUI.icons;
    const { fillOptions, optionsHtml, pickerRow, renderEntityPicker } = CaroUI.fields;
    const { escapeAttr, escapeHtml } = CaroUI.text;

    const setAgentSettingsStatus = (text, kind = '') => setSystemMessage($('#agentSettingsStatus'), text, kind);
    const setAgentProfileFormStatus = (text, kind = '') =>
      setSystemMessage($('#agentProfileFormStatus'), text, kind);
    const setShortcutSettingsStatus = (text, kind = '') =>
      setSystemMessage($('#shortcutSettingsStatus'), text, kind);
    let previousManagedAgentProfileId = null;
    let agentProfileSaving = false;
    let agentProfilePickerMode = 'pick';
    let agentProfilePicker;

    const clearAgentProfileForm = () => {
      $('#agentProfileApiKey').val('');
      $('#agentProfileProvider').val('deepseek');
      $('#agentProfileModel').val('');
      $('#agentProfileBaseUrl').val('');
      $('#agentProfileEffort').val('auto');
    };
    const agentProfileValues = name => ({
      name, provider: $('#agentProfileProvider').val(), model: $('#agentProfileModel').val(),
      baseUrl: $('#agentProfileBaseUrl').val(), reasoningEffort: $('#agentProfileEffort').val(),
      apiKey: $('#agentProfileApiKey').val(),
    });
    const agentProfileReady = () => !agentProfileSaving;
    const agentProfileForm = () => $('#agentProfileForm')[0];

    const showAgentProfile = profile => {
      if (profile) previousManagedAgentProfileId = profile.id;
      clearAgentProfileForm();
      if (profile) {
        $('#agentProfileProvider').val(profile.provider);
        $('#agentProfileModel').val(profile.model);
        $('#agentProfileBaseUrl').val(profile.baseUrl);
        $('#agentProfileEffort').val(profile.reasoningEffort);
      }
      $('#agentProfileFormTitle').text(profile ? `CONFIGURATION: ${profile.name}` : 'NEW CONFIGURATION');
      $('#agentProfileFormHint').text(profile
        ? 'Update this Agent configuration. Rename it from the configuration picker.'
        : 'Complete this configuration, then select Create.');
      $('#agentProfileApiKey')
        .prop('required', !profile)
        .attr('placeholder', profile ? 'Leave blank to keep the saved key' : 'Enter API key');
      $('#agentProfileApiKeyHelp').text(profile
        ? 'Leave blank to keep the key stored in the macOS Keychain.'
        : 'Required and stored in the macOS Keychain.');
      setAgentProfileFormStatus('');
    };

    // Agent configurations have the same identity lifecycle as collections and note types, but their creation
    // needs the details below the row as well. The shared picker owns the name and selection; this manager owns
    // the requests that turn a completed detail form into a saved configuration.
    const agentProfiles = CaroUI.entityManager({
      list: async () => getAgentSettings().profiles,
      create: async name => (await request('/api/agent-profiles', {
        method: 'POST', body: JSON.stringify(agentProfileValues(name)),
      })).profile,
      rename: async (id, name) => (await request(`/api/agent-profiles/${encodeURIComponent(id)}`, {
        method: 'PUT', body: JSON.stringify({ name }),
      })).profile,
      remove: async id => request(`/api/agent-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    });

    const renderAgentSettings = () => {
      const { enabled } = getAgentSettings();
      const toggleLabel = `${enabled ? 'Disable' : 'Enable'} Anki Agent`;
      $('#agentToggle')
        .toggleClass('is-enabled', enabled)
        .attr({ 'aria-checked': String(enabled), 'aria-label': toggleLabel, title: toggleLabel });
      $('#agentAvailabilityText').text(enabled ? 'Enabled' : 'Disabled');
      agentProfilePicker.render();
      applyAgentAvailability();
    };

    const loadAgentSettings = async preferredId => {
      const settings = await request('/api/agent-settings');
      setAgentSettings(settings);
      const selected = settings.profiles.find(profile => profile.id === preferredId)
        || settings.profiles.find(profile => profile.id === previousManagedAgentProfileId)
        || settings.profiles[0];
      await agentProfiles.load(selected?.id);
      showAgentProfile(agentProfiles.selected());
      if (!agentProfiles.selected()) agentProfilePicker.toCreate();
      else renderAgentSettings();
      return settings;
    };

    const revealAgentConfig = () => $('#agentProfileForm')[0].scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    $('#agentToggle').on('click', async () => {
      const agentSettings = getAgentSettings();
      if (!agentSettings.enabled && !agentSettings.profiles.length) {
        setAgentSettingsStatus('Create a configuration before enabling Anki Agent.', 'warn');
        agentProfilePicker.toCreate();
        revealAgentConfig();
        return;
      }
      try {
        const updated = await request('/api/agent-settings', {
          method: 'PUT', body: JSON.stringify({ enabled: !agentSettings.enabled }),
        });
        setAgentSettings(updated);
        renderAgentSettings();
      } catch (error) { setAgentSettingsStatus(error.message, 'error'); }
    });

    $('#agentName').on('change', async event => {
      const agentSettings = getAgentSettings();
      if (state.busy || state.pending) return $(event.currentTarget).val(agentSettings.activeProfileId);
      const activeProfileId = event.currentTarget.value;
      state.busy = true;
      applyAgentAvailability();
      try {
        const updated = await request('/api/agent-settings', {
          method: 'PUT', body: JSON.stringify({ activeProfileId }),
        });
        setAgentSettings(updated);
      } catch (error) {
        setStatus('error', error.message);
      } finally {
        state.busy = false;
        renderAgentSettings();
      }
    });

    $('#agentProfileForm')[0].addEventListener('invalid', () =>
      setAgentProfileFormStatus('Complete the required fields before saving.', 'error'), true);

    $('#agentProfileForm, #agentProfilePicker').on('input change', '.field', () => setAgentProfileFormStatus(''));

    const writeAgentProfile = async (work, success, { onSaved } = {}) => {
      if (agentProfileSaving) return;
      agentProfileSaving = true;
      agentProfilePicker.render();
      setAgentProfileFormStatus('Saving configuration…', 'pending');
      try {
        const saved = await work();
        await loadAgentSettings(saved?.id);
        await onSaved?.(saved);
        setAgentProfileFormStatus(success, 'ok');
      } catch (error) { setAgentProfileFormStatus(error.message, 'error'); }
      finally {
        agentProfileSaving = false;
        agentProfilePicker.render();
      }
    };

    $('#agentProfileForm').on('change', '.field', () => {
      const id = agentProfiles.selectedId();
      if (agentProfilePicker.mode() !== 'pick' || !id) return;
      writeAgentProfile(async () => (await request(`/api/agent-profiles/${encodeURIComponent(id)}`, {
        method: 'PUT', body: JSON.stringify(agentProfileValues(agentProfiles.selected().name)),
      })).profile, 'Configuration saved.');
    });

    $('#agentProfileForm').on('submit', event => {
      event.preventDefault();
      if (agentProfilePicker.mode() === 'create') $('#agentProfileConfirm').trigger('click');
    });

    agentProfilePicker = pickerRow({
      manager: agentProfiles,
      ids: {
        select: '#agentProfileSelect', rename: '#agentProfileName', create: '#agentNewProfileName',
        confirm: '#agentProfileConfirm', back: '#agentProfileReturn', remove: '#agentProfileDelete',
      },
      sentinel: '- New configuration -',
      entity: 'configuration',
      option: { value: profile => profile.id, label: profile => profile.name, name: profile => profile.name },
      isReady: agentProfileReady,
      canCommit: mode => mode !== 'create' || agentProfileForm().reportValidity(),
      stay: [
        '#agentProfileProvider', '#agentProfileModel', '#agentProfileBaseUrl', '#agentProfileEffort',
        '#agentProfileApiKey',
      ],
      run: writeAgentProfile,
      messages: {
        created: name => `Created ${name}.`,
        renamed: (from, name) => `Renamed ${from} to ${name}.`,
      },
      onPick: () => showAgentProfile(agentProfiles.selected()),
      onMode: mode => {
        const changed = mode !== agentProfilePickerMode;
        agentProfilePickerMode = mode;
        $('#agentProfileForm').prop('hidden', mode === 'rename' || (mode === 'pick' && !agentProfiles.selected()));
        $('#agentProfileDelete').prop('disabled', !agentProfileReady() || !agentProfiles.canDelete());
        if (changed && mode === 'create') showAgentProfile(null);
        if (changed && mode === 'pick') showAgentProfile(agentProfiles.selected());
      },
    });

    const deleteAgentProfileConfirm = armedConfirm(() => writeAgentProfile(
      () => agentProfiles.remove(agentProfiles.selectedId()), 'Configuration deleted.',
    ));
    $('#agentProfileDelete').on('click', event =>
      deleteAgentProfileConfirm.handle(event, 'Click again to delete this configuration'));

    // Anki settings
    let ankiSettingsState = null;
    let ankiModelSource = [];
    let ankiDeckSource = [];

    const setAnkiSettingsStatus = (text, kind = '') => setSystemMessage($('#ankiSettingsStatus'), text, kind);

    const renderAnkiRuntime = () => {
      const problem = ankiSettingsState?.runtime?.available === false ? ankiSettingsState.runtime.error : '';
      $('#ankiRuntimeState').text(problem);
    };

    // The settings form only edits collection defaults, but its note-type and deck lists are the same
    // collection entities edited in the studios. Keeping their current snapshot in managers makes every picker
    // read the same source of truth, including a saved default that is temporarily absent from a bridge response.
    const ankiModels = CaroUI.entityManager({
      id: model => model,
      labelOf: model => model,
      list: async () => [...new Set([
        ...(ankiSettingsState?.modelName ? [ankiSettingsState.modelName] : []), ...ankiModelSource,
      ])],
    });
    const ankiDecks = CaroUI.entityManager({
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
        ? 'Quick search lists every deck in the collection.'
        : 'Quick search lists only the decks checked here.');
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

    // Profiles entity manager
    let ankiProfileReloadRequired = false;
    let ankiProfileSaving = false;
    const setAnkiProfileStatus = (text, kind = '') => setSystemMessage($('#ankiProfileStatus'), text, kind);

    const ankiProfiles = CaroUI.entityManager({
      list: async () => {
        const { activeProfileId, profiles } = await request('/api/profiles');
        ankiProfiles.activeId = activeProfileId;
        return profiles;
      },
      create: async name => (await request('/api/profiles', { method: 'POST', body: JSON.stringify({ name }) })).profile,
      rename: async (profile, name) => {
        const result = await request(`/api/profiles/${encodeURIComponent(profile.id)}/rename`, {
          method: 'POST', body: JSON.stringify({ name }),
        });
        ankiProfileReloadRequired = result.reloadRequired;
        return result.profile;
      },
      remove: async profile => request(`/api/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' }),
      canRename: profile => Boolean(profile?.active) && Boolean(profile?.canRename),
      canDelete: profile => Boolean(profile) && !profile.active && Boolean(profile.canActivate) && profile.managed,
    });
    ankiProfiles.activeId = null;

    const ankiProfileById = id => ankiProfiles.items().find(profile => profile.id === id);
    const activeAnkiProfile = () => ankiProfileById(ankiProfiles.activeId) || null;
    // The row falls back to the profile that is actually open while the list is still loading, so what the row's
    // own two buttons are offered for is read from here instead of straight off the manager's selection.
    const shownAnkiProfile = () => ankiProfiles.selected() || activeAnkiProfile();
    const ankiProfileReady = () => !ankiProfileSaving && $('#ankiSettingsPanel').attr('aria-busy') !== 'true';

    // Profiles are the one list whose entity is a whole collection rather than a name in one, so the row shows
    // one sentence at a time under it: what is open, what a rename would move, and — while the form for one is
    // showing — the fact that this write is asked for twice, which is the only place the second press is stated
    // before it is made.
    const renderAnkiProfileHelp = mode => {
      const profile = shownAnkiProfile();
      const ready = ankiProfileReady();
      const canRename = ankiProfiles.canRename() && ready;
      $('#ankiProfileHelp').text(mode === 'rename'
        ? 'Renaming moves this collection, its media, and its backups into the folder the new name gives it, so'
          + ' the write is asked for twice: press Enter again on the button to move it.'
        : !ready ? 'Loading the collection before profile changes are available.'
        : !profile
          ? 'Create a profile to start an empty collection with its own defaults, AnkiWeb account, and chats.'
          : canRename
            ? `Current folder: ${profile.storageName}. Renaming moves the collection, media, and backups together,`
              + ' and the active profile is the one that cannot be deleted.'
            : profile.active
              ? 'This collection is managed outside Caro Anki, so it cannot be renamed or deleted here.'
              : `Select Switch to open ${profile.name}, or delete it: the whole folder is copied into`
                + ' profile-backups first. Only the profile that is currently open can be renamed.');
    };

    // A write repaints the row and the row's own `run` is that write, so the two are circular: the write is
    // declared first and the row's paint is the one thing it takes from the row at call time.
    //
    // Every profile write goes through here, which is what the row inherits: one at a time, with the row's own
    // buttons standing down while one is in flight. It is also where the reload belongs — a rename moves the
    // collection's folder and a switch points the app at another one, so either way the page re-reads the path
    // before a collection is opened again. A write whose sentence depends on its own answer (a delete says
    // whether the collection was backed up first) answers with that sentence instead of being given one.
    const writeAnkiProfile = async (work, success, { onSaved } = {}) => {
      if (ankiProfileSaving) return;
      ankiProfileSaving = true;
      renderAnkiProfile();
      setAnkiProfileStatus('Saving…', 'pending');
      try {
        const answer = await work();
        const sentence = success ?? answer;
        setAnkiProfileStatus(ankiProfileReloadRequired ? `${sentence} Reloading…` : sentence, 'ok');
        await onSaved?.();
        if (ankiProfileReloadRequired) {
          ankiProfileReloadRequired = false;
          window.setTimeout(() => window.location.reload(), 350);
        }
      } catch (error) {
        setAnkiProfileStatus(error.message, 'error');
      } finally {
        ankiProfileSaving = false;
        renderAnkiProfile();
      }
    };

    // The section is painted by the row: every change to the selection, to the mode, or to a write in flight goes
    // through the row's own render, so the callers that only know "the profiles are ready" call this.
    const renderAnkiProfile = () => profilePicker.render();

    // The list, the profile that is open, the form for a new one, and the two writes are one control, exactly as
    // in the studios. Two things this row has that a studio's does not: the switch beside it, which opens the
    // collection the list is showing and is therefore not the row's own confirm button, and a rename that is
    // armed, because it moves a folder rather than a name.
    const profilePicker = pickerRow({
      manager: ankiProfiles,
      ids: {
        select: '#ankiProfileSelect', rename: '#ankiProfileName', create: '#ankiNewProfileName',
        confirm: '#ankiProfileConfirm', back: '#ankiProfileReturn', remove: '#ankiProfileDelete',
      },
      sentinel: '- New Profile -',
      entity: 'profile',
      option: {
        value: item => item.id,
        label: item => `${item.name}${item.active ? ' (current)' : ''}`,
        name: item => item.name,
      },
      isReady: ankiProfileReady,
      run: writeAnkiProfile,
      // The row hands over the key of the entity it is renaming, and this list is keyed by an id while the
      // request is made with the profile itself, so the one rename the manager takes is spelled out.
      rename: (id, name) => ankiProfiles.rename(ankiProfileById(id), name),
      arm: {
        className: 'button-confirm',
        hint: name => `Press Enter again to rename this collection to "${name}"`,
      },
      messages: {
        created: name => `${name} is ready. Select Switch to open it.`,
        renamed: (from, name) => `Renamed ${from} to ${name}.`,
      },
      // The switch opens a collection rather than writing the list, so it is only there while the list is, and
      // the delete only ever destroys a profile that is not the open one; both stand down during a write and
      // while the panel is still loading them.
      onMode: mode => {
        const ready = ankiProfileReady();
        const profile = shownAnkiProfile();
        $('#ankiProfileActivate').prop('hidden', mode !== 'pick')
          .prop('disabled', !(ready && profile?.canActivate && !profile.active));
        $('#ankiProfileDelete').prop('disabled', !(ready && ankiProfiles.canDelete()));
        renderAnkiProfileHelp(mode);
      },
      onPick: () => setAnkiProfileStatus(''),
    });

    const loadAnkiProfiles = async () => {
      await ankiProfiles.load(ankiProfiles.activeId);
      // The list states which collection is open in an answer rather than in its order, so the row is put on
      // that profile instead of on whatever came first: the row's own two writes are offered for what it shows,
      // and opening Settings on a profile that is not the one in use offers to delete a collection that is not
      // the one being deleted.
      ankiProfiles.select(ankiProfiles.activeId);
      renderAnkiProfile();
      return ankiProfiles;
    };

    const activateAnkiProfile = async () => {
      const profile = shownAnkiProfile();
      if (!profile || profile.active) return;
      await writeAnkiProfile(async () => {
        const result = await request(`/api/profiles/${encodeURIComponent(profile.id)}/activate`, {
          method: 'POST', body: JSON.stringify({}),
        });
        clearPendingChat();
        writeBrowserView({ sessionId: null });
        await ankiProfiles.load(result.profile.id);
        ankiProfileReloadRequired = result.reloadRequired;
        return 'Profile switched.';
      });
    };

    const deleteAnkiProfileConfirm = armedConfirm(() => {
      const profile = shownAnkiProfile();
      if (!profile) return setAnkiProfileStatus('Select a collection profile to delete.', 'error');
      return writeAnkiProfile(async () => {
        const result = await ankiProfiles.remove(profile);
        ankiProfiles.select(result.activeProfileId);
        return result.backupCreated
          ? `${result.removed} was deleted. Its collection was copied into profile-backups first.`
          : `${result.removed} was deleted.`;
      });
    });

    $('#ankiProfileDelete').on('click', event => {
      if (!ankiProfiles.canDelete() || !ankiProfileReady()) return;
      deleteAnkiProfileConfirm.handle(event, 'Click again to delete this collection and its chats');
    });
    $('#ankiProfileActivate').on('click', () => activateAnkiProfile());
    $('#ankiProfileName').on('input', () => setAnkiProfileStatus(''));

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

    // Library entries
    let libraryEntries = [];
    let libraryShown = null;
    const setLibraryStatus = (text, kind = '') => setSystemMessage($('#librarySettingsStatus'), text, kind);
    const libraryEntry = ({ type, name }) => libraryEntries.find(entry => entry.type === type && entry.name === name);
    const libraryEntryButton = entry => $('#libraryEntries').find('.library-entry').filter((_, button) =>
      button.dataset.type === entry.type && button.dataset.name === entry.name);

    const markLibraryShown = () => {
      $('.library-entry').removeClass('is-selected');
      if (libraryShown) libraryEntryButton(libraryShown).addClass('is-selected');
    };

    const clearLibraryEditor = () => {
      libraryShown = null;
      $('#libraryEntryType, #libraryEntryName, #libraryEditorName, #libraryEditorDescription, #libraryEditorContent')
        .val('');
      $('#libraryEditorTitle').text('SELECT AN ENTRY');
      $('#libraryNameField, #libraryDescriptionField').prop('hidden', true);
      $('#libraryNameLabel').text('Name');
      markLibraryShown();
    };

    const selectLibraryEntry = entry => {
      const editableDescription = entry.type === 'skills' && entry.draft;
      libraryShown = { type: entry.type, name: entry.name };
      $('#libraryEntryType').val(entry.type); $('#libraryEntryName').val(entry.name);
      $('#libraryEditorTitle').text(entry.draft ? `NEW ${entry.type.slice(0, -1).toUpperCase()}`
        : `${entry.type.slice(0, -1).toUpperCase()}: ${displayLibraryName(entry)}`);
      $('#libraryNameField').prop('hidden', false);
      $('#libraryNameLabel').text(entry.type === 'instructions' ? 'File name' : 'Skill name');
      $('#libraryDescriptionField').prop('hidden', !editableDescription);
      $('#libraryEditorName').val(displayLibraryName(entry));
      $('#libraryEditorDescription').val(entry.description || '');
      $('#libraryEditorContent').val(entry.content ?? entry.body ?? '').trigger('focus');
      markLibraryShown();
    };

    const libraryEntryHtml = entry => {
      const name = escapeAttr(entry.name);
      const draft = entry.draft ? ' is-draft' : '';
      const title = entry.draft ? ' title="Unsaved draft"' : '';
      return `<div class="library-entry-row${draft}">
        <button class="library-entry" type="button" data-type="${entry.type}" data-name="${name}"${title}>
          ${escapeHtml(displayLibraryName(entry))}
        </button>
        <button class="button button-quiet button-icon library-delete" type="button" data-type="${entry.type}"
          data-name="${name}" aria-label="Delete ${name}" title="Delete">${icon('trash')}</button>
      </div>`;
    };

    const libraryAddHtml = type => {
      const label = type.slice(0, -1);
      return `<div class="library-add-row">
        <input class="field field-sm library-add-name" data-type="${type}" placeholder="Name"
          aria-label="New ${label} name">
        <button class="button button-quiet button-icon library-add" type="button" data-type="${type}"
          aria-label="Add ${label}" title="Add ${label}">${icon('plus')}</button>
      </div>`;
    };

    const renderLibraryEntries = () => {
      const groups = ['instructions', 'skills'].map(type => {
        const entries = libraryEntries.filter(entry => entry.type === type && !entry.seeded);
        const list = entries.map(libraryEntryHtml).join('') || '<p class="dialog-help">None</p>';
        return `<section class="library-group">
          <header class="library-group-heading"><h3 class="eyebrow">${type.toUpperCase()}</h3></header>
          ${list}${libraryAddHtml(type)}
        </section>`;
      });
      // The list is written only when the entries themselves changed, so a save that rewrote one body — or a
      // re-read that answered the same list — leaves the column where it is. Which entry the editor shows is a
      // class on its own button, and a column that was not rebuilt keeps it, so it is re-applied only when the
      // markup really was rewritten.
      fillOptions($('#libraryEntries'), groups.join(''));
      markLibraryShown();
    };

    const loadLibrarySettings = async () => {
      const [{ instructions }, { skills }] = await Promise.all([request('/api/instructions'), request('/api/skills')]);
      const loaded = [...instructions.map(entry => ({ ...entry, type: 'instructions' })),
        ...skills.map(entry => ({ ...entry, type: 'skills' }))];
      libraryEntries = [...loaded, ...libraryEntries.filter(entry => entry.draft
        && !loaded.some(saved => sameLibraryEntry(saved, entry)))];
      renderLibraryEntries();
    };

    // A library entry saves itself the way a card template does: the body, and the description a skill carries,
    // are written once typing pauses, and the name — which is a file, or a folder — is a commit that lands when
    // the field is left or Enter is pressed. A new entry is created by its first real write, so a draft with
    // nothing typed in it is never written, and a pending write is flushed before another entry is shown,
    // because a debounce that outlived its editor would write one entry's body into the next one's.
    let librarySaving = false;
    let libraryQueued = null;
    let libraryTimer = null;

    const saveLibraryEntry = async ({ rename = false } = {}) => {
      if (librarySaving) { libraryQueued = { rename: rename || libraryQueued?.rename }; return; }
      const type = $('#libraryEntryType').val();
      const sourceName = $('#libraryEntryName').val();
      const name = normalizeLibraryName(type, $('#libraryEditorName').val() || sourceName);
      if (!type || !name) return;
      const entry = libraryEntry({ type, name: sourceName });
      const existing = Boolean(entry && !entry.draft);
      const target = libraryEntry({ type, name });
      if (target && target !== entry) {
        setLibraryStatus(target.seeded
          ? `${displayLibraryName(target)} is a bundled skill.`
          : target.draft ? `${displayLibraryName(target)} has an unsaved draft.`
          : `${displayLibraryName(target)} already exists.`, 'error');
        return;
      }
      const content = $('#libraryEditorContent').val();
      const description = $('#libraryEditorDescription').val();
      const renameRequested = rename && existing && name !== sourceName;
      // A body that already reads as the stored one is not a write, which is also what keeps an idle pause
      // quiet; and a new entry is created only once it has something in it.
      const contentChanged = existing
        ? content !== (entry.content ?? entry.body ?? '')
          || (type === 'skills' && description !== (entry.description ?? ''))
        : Boolean(content.trim() || (type === 'skills' && description.trim()));
      if (!contentChanged && !renameRequested) return;
      librarySaving = true;
      setLibraryStatus('Saving…', 'pending');
      let resolvedName = sourceName;
      let contentSaved = false;
      let didRename = false;
      try {
        if (!existing || contentChanged) {
          const payload = type === 'skills' ? { body: content, description, name } : { content, name };
          const result = await request(existing
            ? `/api/${type}/${encodeURIComponent(sourceName)}` : `/api/${type}`, {
            method: existing ? 'PUT' : 'POST', body: JSON.stringify(payload),
          });
          // A save answers the file it wrote under `name`, while a rename answers the name it moved from under
          // `name` and the one it moved to under `to` — so each half is read from the field that holds it.
          resolvedName = (type === 'skills' ? result.skill : result.instruction).name || resolvedName;
          contentSaved = true;
        }
        if (renameRequested) {
          const result = await request(`/api/${type}/${encodeURIComponent(sourceName)}`, {
            method: 'PATCH', body: JSON.stringify({ to: name }),
          });
          resolvedName = (type === 'skills' ? result.skill : result.instruction).to || name;
          didRename = true;
        }
        if (!existing) libraryEntries = libraryEntries.filter(item => item !== entry);
        // The editor may have moved to another entry while these writes were in flight, and what it shows is
        // that entry's state — a save that lands late never drags the editor back to the one it wrote.
        if (libraryShown?.type === type && libraryShown.name === sourceName) {
          libraryShown = { type, name: resolvedName };
          $('#libraryEntryName').val(resolvedName);
          if (!existing || renameRequested) {
            const shown = displayLibraryName({ type, name: resolvedName });
            $('#libraryEditorName').val(shown);
            $('#libraryEditorTitle').text(`${type.slice(0, -1).toUpperCase()}: ${shown}`);
          }
        }
        await loadLibrarySettings();
        setLibraryStatus(renameRequested && contentSaved ? 'Renamed and saved.'
          : renameRequested ? 'Renamed.' : 'Saved.', 'ok');
      } catch (error) {
        setLibraryStatus(renameRequested && contentSaved && !didRename
          ? `Content saved, but rename failed: ${error.message}` : error.message, 'error');
      } finally {
        librarySaving = false;
        const next = libraryQueued;
        libraryQueued = null;
        if (next) saveLibraryEntry(next);
      }
    };

    const flushLibrarySave = () => {
      if (libraryTimer === null) return;
      clearTimeout(libraryTimer);
      libraryTimer = null;
      saveLibraryEntry({ rename: true });
    };

    const scheduleLibrarySave = () => {
      clearTimeout(libraryTimer);
      libraryTimer = setTimeout(() => { libraryTimer = null; saveLibraryEntry({}); }, 500);
    };

    $('#libraryEditorContent').on('input', scheduleLibrarySave);
    $('#libraryEditorDescription').on('change', () => saveLibraryEntry({}));
    $('#libraryEditorName')
      .on('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        saveLibraryEntry({ rename: true });
      })
      .on('change', () => saveLibraryEntry({ rename: true }));

    $('#libraryEntries').on('click', '.library-entry', event => {
      flushLibrarySave();
      selectLibraryEntry(libraryEntry(event.currentTarget.dataset));
    });

    const deleteLibraryEntryConfirm = armedConfirm(async $button => {
      const { type, name } = $button[0].dataset;
      const entry = libraryEntry({ type, name });
      if (entry.draft) {
        libraryEntries = libraryEntries.filter(item => item !== entry);
        renderLibraryEntries(); clearLibraryEditor(); setLibraryStatus('Draft discarded.', 'ok');
        return;
      }
      $button.prop('disabled', true); setLibraryStatus('Deleting…', 'pending');
      try {
        await request(`/api/${type}/${encodeURIComponent(name)}`, { method: 'DELETE' });
        await loadLibrarySettings(); clearLibraryEditor(); setLibraryStatus('Deleted.', 'ok');
      } catch (error) { setLibraryStatus(error.message, 'error'); $button.prop('disabled', false); }
    });

    $('#libraryEntries').on('click', '.library-delete', event => {
      // A write still waiting on its idle is dropped rather than flushed: the entry it would land in is the one
      // being deleted, and a body written back into it would put it there again.
      clearTimeout(libraryTimer);
      libraryTimer = null;
      const entry = libraryEntry(event.currentTarget.dataset);
      deleteLibraryEntryConfirm.handle(event, `Click again to delete ${displayLibraryName(entry)}`);
    });

    $('#libraryEntries').on('click', '.library-add', event => {
      flushLibrarySave();
      const type = event.currentTarget.dataset.type;
      const inputName = $(event.currentTarget).siblings('.library-add-name').val().trim();
      if (!inputName) return;
      const name = normalizeLibraryName(type, inputName);
      const existing = libraryEntry({ type, name });
      if (existing) {
        setLibraryStatus(existing.seeded
          ? `${displayLibraryName(existing)} is a bundled skill.`
          : `${displayLibraryName({ type, name })} already exists.`, 'error');
        return;
      }
      const entry = {
        type, name, draft: true, content: '', description: type === 'skills' ? `New ${name} skill.` : '',
      };
      libraryEntries.push(entry); renderLibraryEntries(); selectLibraryEntry(entry);
      setLibraryStatus('Draft added. It is created as soon as you type.', 'ok');
    });

    $('#libraryEntries').on('keydown', '.library-add-name', event => {
      if (event.key === 'Enter') $(event.currentTarget).siblings('.library-add').trigger('click');
    });

    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    let shortcutCaptureId = null;
    let shortcutFilter = '';
    const shortcutRowHtml = shortcut => {
      const isDefault = NoteShortcuts.sameBinding(shortcut, NoteShortcuts.defaultFor(shortcut.id));
      const bindingLabel = NoteShortcuts.display(shortcut, isMac);
      const name = escapeAttr(shortcut.id);
      return `<div class="shortcut-setting" role="listitem">
        <span class="shortcut-setting-label">${escapeHtml(shortcut.label)}</span>
        <button class="field field-sm shortcut-binding${shortcutCaptureId === shortcut.id ? ' is-capturing' : ''}"
          type="button" data-shortcut-id="${name}" aria-label="Set shortcut for ${escapeAttr(shortcut.label)}"
          title="Select, then press a new shortcut">${escapeHtml(
            shortcutCaptureId === shortcut.id ? 'Press keys…' : bindingLabel,
          )}</button>
        <button class="button button-quiet button-icon shortcut-reset" type="button" data-shortcut-id="${name}"
          aria-label="Restore ${escapeAttr(shortcut.label)} shortcut" title="Restore default shortcut"${
            isDefault ? ' disabled' : ''
          }>${icon('back')}</button>
      </div>`;
    };
    const matchingShortcuts = () => {
      const query = shortcutFilter.trim().toLowerCase();
      return NoteShortcuts.definitions.filter(shortcut => !query || [
        shortcut.id, shortcut.label, NoteShortcuts.display(shortcut, isMac),
      ].join(' ').toLowerCase().includes(query));
    };
    const renderShortcutSettings = () => {
      const shortcuts = matchingShortcuts();
      $('#shortcutSettingsList').html(shortcuts.length
        ? shortcuts.map(shortcutRowHtml).join('')
        : '<p class="dialog-help shortcut-empty">No shortcuts match your search.</p>');
    };
    const persistShortcuts = () => {
      NoteShortcuts.persist(localStorage, config.storageKeys.ankiShortcuts);
      $(document).trigger('anki-shortcuts-changed');
    };
    const renderShortcutRow = ($row, shortcut) => {
      $row.find('.shortcut-binding').removeClass('is-capturing').text(NoteShortcuts.display(shortcut, isMac));
      $row.find('.shortcut-reset').prop('disabled', NoteShortcuts.sameBinding(
        shortcut, NoteShortcuts.defaultFor(shortcut.id)));
    };
    const restoreShortcut = (id, message, $row) => {
      NoteShortcuts.reset(id);
      persistShortcuts();
      shortcutCaptureId = null;
      renderShortcutRow($row, NoteShortcuts.find(id));
      setShortcutSettingsStatus(message, 'ok');
    };
    $('#shortcutSettingsList').on('click', '.shortcut-binding', event => {
      shortcutCaptureId = event.currentTarget.dataset.shortcutId;
      $(event.currentTarget).addClass('is-capturing').text('Press keys…').trigger('focus');
    });
    $('#shortcutSettingsList').on('focusout', '.shortcut-binding', event => {
      if (shortcutCaptureId !== event.currentTarget.dataset.shortcutId) return;
      shortcutCaptureId = null;
      const shortcut = NoteShortcuts.find(event.currentTarget.dataset.shortcutId);
      $(event.currentTarget).removeClass('is-capturing').text(NoteShortcuts.display(shortcut, isMac));
    });
    $('#shortcutSettingsList').on('keydown', '.shortcut-binding', event => {
      event.preventDefault();
      const id = event.currentTarget.dataset.shortcutId;
      const binding = NoteShortcuts.capture(event.originalEvent);
      if (!binding) {
        setShortcutSettingsStatus('Use Command or Control with another key.', 'warn');
        return;
      }
      const conflict = NoteShortcuts.definitions.find(shortcut => shortcut.id !== id
        && NoteShortcuts.sameBinding(shortcut, binding));
      if (conflict) {
        setShortcutSettingsStatus(
          `${NoteShortcuts.display(binding, isMac)} is already used by ${conflict.label}.`, 'error');
        return;
      }
      const previous = NoteShortcuts.binding(NoteShortcuts.find(id));
      try {
        NoteShortcuts.update(id, binding);
        persistShortcuts();
        shortcutCaptureId = null;
        renderShortcutRow($(event.currentTarget).closest('.shortcut-setting'), NoteShortcuts.find(id));
        setShortcutSettingsStatus(
          `${NoteShortcuts.find(id).label} saved as ${NoteShortcuts.display(binding, isMac)}.`, 'ok');
      } catch (error) {
        NoteShortcuts.update(id, previous);
        shortcutCaptureId = null;
        renderShortcutRow($(event.currentTarget).closest('.shortcut-setting'), NoteShortcuts.find(id));
        setShortcutSettingsStatus(error.message, 'error');
      }
    });
    $('#shortcutSettingsList').on('click', '.shortcut-reset', event => {
      const shortcut = NoteShortcuts.find(event.currentTarget.dataset.shortcutId);
      try {
        restoreShortcut(shortcut.id, `Restored ${shortcut.label}.`,
          $(event.currentTarget).closest('.shortcut-setting'));
      }
      catch (error) { setShortcutSettingsStatus(error.message, 'error'); }
    });
    $('#shortcutFilter').on('input', event => {
      shortcutCaptureId = null;
      shortcutFilter = event.currentTarget.value;
      renderShortcutSettings();
    });
    $('#shortcutResetAll').on('click', () => {
      try {
        NoteShortcuts.resetAll();
        persistShortcuts();
        shortcutCaptureId = null;
        matchingShortcuts().forEach(shortcut => renderShortcutRow(
          $(`.shortcut-reset[data-shortcut-id="${shortcut.id}"]`).closest('.shortcut-setting'), shortcut));
        setShortcutSettingsStatus('Restored all default shortcuts.', 'ok');
      } catch (error) { setShortcutSettingsStatus(error.message, 'error'); }
    });

    const loadedSettingsSections = new Set();
    const settingsDialog = createDialog({
      selector: '#ankiSettingsDialog',
      onClose: () => {
        // A write still waiting on its idle is sent before the editor is emptied: closing the dialog is not how
        // an instruction is thrown away. It reads the fields it needs before its first await, so the reset below
        // cannot reach it.
        flushLibrarySave();
        loadedSettingsSections.clear();
        libraryEntries = libraryEntries.filter(entry => !entry.draft);
        clearLibraryEditor();
        shortcutCaptureId = null;
        shortcutFilter = '';
        $('#shortcutFilter').val('');
      },
    });

    const selectSettingsSection = section => {
      $('.settings-tab').each((_, tab) => {
        const selected = $(tab).data('settings-section') === section;
        $(tab).toggleClass('is-active', selected)
          .attr({ 'aria-selected': String(selected), tabindex: selected ? 0 : -1 });
      });
      $('#ankiSettingsPanel').prop('hidden', section !== 'anki');
      $('#quickSettingsPanel').prop('hidden', section !== 'quick');
      $('#shortcutsSettingsPanel').prop('hidden', section !== 'shortcuts');
      $('#agentSettingsPanel').prop('hidden', section !== 'agent');
      $('#librarySettingsPanel').prop('hidden', section !== 'library');
    };

    const loadSettingsSection = async section => {
      if (loadedSettingsSections.has(section)) return;
      if (section === 'agent') await loadAgentSettings();
      else if (section === 'library') await loadLibrarySettings();
      else if (section === 'shortcuts') renderShortcutSettings();
      else {
        await Promise.all([loadAnkiSettings(), loadAnkiProfiles()]);
        try { await loadAnkiChoices(); }
        catch {
          setAnkiSettingsStatus('Unable to read note types from the collection.', 'error');
          return;
        }
      }
      loadedSettingsSections.add(section);
    };

    const showSettingsSection = section => {
      selectSettingsSection(section);
      const $panel = $(`#${section}SettingsPanel`).attr('aria-busy', 'true');
      loadSettingsSection(section).catch(error => {
        if (section === 'agent') setAgentSettingsStatus(error.message, 'error');
        else if (section === 'library') setSystemMessage($('#librarySettingsStatus'), error.message, 'error');
        else if (section === 'shortcuts') setShortcutSettingsStatus(error.message, 'error');
        else setAnkiSettingsStatus(error.message, 'error');
      }).finally(() => {
        $panel.attr('aria-busy', 'false');
        if (section === 'anki') renderAnkiProfile();
      });
    };

    const openSettings = section => {
      setAnkiSettingsStatus('');
      setAgentSettingsStatus('');
      setShortcutSettingsStatus('');
      selectSettingsSection(section);
      settingsDialog.open();
      showSettingsSection(section);
    };

    $('#ankiSettingsOpen').on('click', () => openSettings('anki'));
    $('.settings-tab').on('click', event => showSettingsSection($(event.currentTarget).data('settings-section')));
    $('.settings-tabs').on('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const sections = ['anki', 'quick', 'shortcuts', 'agent', 'library'];
      const current = $('.settings-tab[aria-selected="true"]').data('settings-section');
      const index = sections.indexOf(current);
      const section = sections[(index + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) % sections.length];
      showSettingsSection(section);
      $(`#${section}SettingsTab`).trigger('focus');
    });

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
        setAnkiSettingsStatus('Check at least one deck, or choose All decks.', 'warn');
        return;
      }
      const settings = {
        modelName: ankiModels.selectedId(),
        allowDuplicate: $('#ankiAllowDuplicate').prop('checked'),
        visibleDecks,
      };
      ankiSettingsSaving = true;
      setAnkiSettingsStatus('Saving…', 'pending');
      try {
        await request('/api/anki-settings', { method: 'PUT', body: JSON.stringify(settings) });
        await loadAnkiSettings();
        setAnkiSettingsStatus('Settings saved.', 'ok');
        $(document).trigger('anki-settings-changed');
      } catch (error) { setAnkiSettingsStatus(error.message, 'error'); }
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
      getAnkiSettingsState: () => ankiSettingsState,
      getAnkiModelChoices: () => ankiModels.items(),
      setAnkiModelChoices: async models => {
        ankiModelSource = models || [];
        await ankiModels.load(ankiSettingsState?.modelName);
        renderAnkiModelChoices();
      },
      loadAgentSettings,
      loadAnkiChoices,
      loadAnkiSettings,
      openSettings,
      renderAgentSettings,
      renderAnkiModelChoices,
      renderAnkiProfile,
      renderAnkiSettings,
    };
  };

  return { createSettingsDialogs, displayLibraryName, normalizeLibraryName, sameLibraryEntry };
});
