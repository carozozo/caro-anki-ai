((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroSettingsDialogs = api;
})(globalThis, () => {
  // The settings dialog is the shell around six panels: it owns the dialog, the tab routing, and the sections
  // that load on first show. Each panel is a module of its own, handed in as a factory so this file only wires
  // them together and never reaches for one off the page.
  const createSettingsDialogs = ({
    $, CaroUI, config, NoteShortcuts, request, state, setStatus,
    renderAnkiAccountButton, clearPendingChat, writeBrowserView,
    getAgentSettings, setAgentSettings, applyAgentAvailability,
    libraryNames, panels,
  }) => {
    const { create: createDialog } = CaroUI.dialogs;

    const agent = panels.agent({
      $, CaroUI, request, state, setStatus, getAgentSettings, setAgentSettings, applyAgentAvailability,
    });
    const ankiDefaults = panels.ankiDefaults({ $, CaroUI, request, renderAnkiAccountButton });
    const ankiMaintenance = panels.ankiMaintenance({ $, CaroUI, request });
    const ankiProfiles = panels.ankiProfiles({ $, CaroUI, request, clearPendingChat, writeBrowserView });
    const listFields = panels.listFields({ $, CaroUI });
    const library = panels.library({ $, CaroUI, request, libraryNames });
    const shortcuts = panels.shortcuts({ $, CaroUI, config, NoteShortcuts });

    // Every section is two levels of labels: the dialog's own tabs are the level above, and each section owns a
    // strip naming the panels inside it. One list per section is the whole of that contract — what its strip is
    // built from, what its arrow keys step through, and which panel it opens on.
    const settingsSections = {
      anki: ['collection-profile', 'maintenance'],
      quick: ['card-defaults', 'deck-list', 'list-fields', 'shortcuts'],
      agent: ['configuration', 'instructions', 'skills', 'memories'],
    };
    const sectionNames = Object.keys(settingsSections);

    const loadedSettingsSections = new Set();
    const settingsDialog = createDialog({
      selector: '#ankiSettingsDialog',
      onClose: () => {
        // A write still waiting on its idle is sent before the editor is emptied: closing the dialog is not how
        // an instruction is thrown away. It reads the fields it needs before its first await, so the reset below
        // cannot reach it.
        library.flush();
        loadedSettingsSections.clear();
        library.reset();
        shortcuts.reset();
      },
    });

    const selectSettingsSection = section => {
      $('.settings-main-tabs .settings-tab').each((_, tab) => {
        const selected = $(tab).data('settingsSection') === section;
        $(tab).toggleClass('is-active', selected)
          .attr({ 'aria-selected': String(selected), tabindex: selected ? 0 : -1 });
      });
      // The section's own strip is a sibling band above the panels, so the section it names decides both which
      // panel shows and which strip is the one on screen.
      sectionNames.forEach(name => {
        $(`#${name}SettingsPanel`).prop('hidden', name !== section);
        $(`.settings-subtabs[data-sub-tabs="${name}"]`).prop('hidden', name !== section);
      });
    };

    // A section's strip names the panels inside it, and each panel answers with `data-sub-panel`: a name the
    // section does not carry leaves its panel hidden, and the panel it opens on is the first of its own list.
    // Two labels can name one panel — the library shows instructions or skills — so the value is a name list.
    const selectSubSection = (section, name) => {
      const $strip = $(`.settings-subtabs[data-sub-tabs="${section}"]`);
      const $section = $(`#${section}SettingsPanel`);
      let $named = $();
      $strip.find('.settings-subtab').each((_, tab) => {
        const selected = $(tab).data('subSection') === name;
        if (selected) $named = $(tab);
        $(tab).toggleClass('is-active', selected)
          .attr({ 'aria-selected': String(selected), tabindex: selected ? 0 : -1 });
      });
      $section.find('[data-sub-panel]').each((_, panel) => {
        const names = String($(panel).data('subPanel')).split(' ');
        const shown = names.includes(name);
        $(panel).prop('hidden', !shown);
        // A panel that two labels can name — the library shows instructions or skills — is named by the label
        // that is showing it rather than by the pair the strip offers.
        if (shown && names.length > 1) $(panel).attr('aria-labelledby', $named.attr('id'));
      });
      // The List Fields panel reads the table's live column controller each time it is shown rather than a
      // snapshot taken when the dialog opened, and the library paints the one kind its label names.
      if (section === 'quick' && name === 'list-fields') listFields.render();
      if (section === 'agent' && ['instructions', 'memories', 'skills'].includes(name)) library.render(name);
    };

    const focusSubSection = (section, name) => {
      selectSubSection(section, name);
      $(`.settings-subtabs[data-sub-tabs="${section}"] .settings-subtab[data-sub-section="${name}"]`)
        .trigger('focus');
    };

    const loadSettingsSection = async section => {
      if (loadedSettingsSections.has(section)) return;
      if (section === 'agent') await Promise.all([agent.load(), library.load()]);
      else if (section === 'anki') await Promise.all([ankiProfiles.load(), ankiMaintenance.load()]);
      else {
        await ankiDefaults.load();
        try { await ankiDefaults.loadChoices(); }
        catch {
          ankiDefaults.setPanelStatus('Unable to read note types from the collection.', 'error');
          return;
        }
        shortcuts.render();
      }
      loadedSettingsSections.add(section);
      selectSubSection(section, settingsSections[section][0]);
    };

    const showSettingsSection = section => {
      selectSettingsSection(section);
      const $panel = $(`#${section}SettingsPanel`).attr('aria-busy', 'true');
      loadSettingsSection(section).catch(error => {
        if (section === 'agent') agent.setPanelStatus(error.message, 'error');
        else if (section === 'anki') ankiProfiles.setPanelStatus(error.message, 'error');
        else ankiDefaults.setPanelStatus(error.message, 'error');
      }).finally(() => {
        $panel.attr('aria-busy', 'false');
        if (section === 'anki') ankiProfiles.render();
      });
    };

    const openSettings = section => {
      ankiDefaults.setPanelStatus('');
      ankiMaintenance.setStatus('');
      ankiProfiles.setPanelStatus('');
      agent.setPanelStatus('');
      shortcuts.setPanelStatus('');
      selectSettingsSection(section);
      settingsDialog.open();
      showSettingsSection(section);
    };

    $('#ankiSettingsOpen').on('click', () => openSettings('anki'));
    $('.settings-main-tabs').on('click', '.settings-tab', event =>
      showSettingsSection($(event.currentTarget).data('settingsSection')));
    $('.settings-main-tabs').on('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const current = $('.settings-main-tabs .settings-tab[aria-selected="true"]').data('settingsSection');
      const index = sectionNames.indexOf(current);
      const section = sectionNames[
        (index + (event.key === 'ArrowRight' ? 1 : -1) + sectionNames.length) % sectionNames.length];
      showSettingsSection(section);
      $(`#${section}SettingsTab`).trigger('focus');
    });

    // A section's own strip is the same gesture one level down, so the same two handlers serve every section:
    // the strip says which section it belongs to in `data-sub-tabs`.
    $('.settings-subtabs').on('click', '.settings-subtab', event => {
      const $tab = $(event.currentTarget);
      selectSubSection($tab.closest('.settings-subtabs').data('subTabs'), $tab.data('subSection'));
    });
    $('.settings-subtabs').on('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const $strip = $(event.currentTarget);
      const section = $strip.data('subTabs');
      const names = settingsSections[section];
      const current = $strip.find('.settings-subtab[aria-selected="true"]').data('subSection');
      const index = names.indexOf(current);
      focusSubSection(section, names[
        (index + (event.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length]);
    });

    return {
      getAnkiSettingsState: () => ankiDefaults.getState(),
      getAnkiModelChoices: () => ankiDefaults.getModelChoices(),
      setAnkiModelChoices: async models => ankiDefaults.setModelChoices(models),
      loadAgentSettings: agent.load,
      loadAnkiChoices: ankiDefaults.loadChoices,
      loadAnkiSettings: ankiDefaults.load,
      openSettings,
      renderAgentSettings: agent.render,
      renderAnkiListFields: listFields.render,
      renderAnkiModelChoices: ankiDefaults.renderModelChoices,
      renderAnkiProfile: ankiProfiles.render,
      renderAnkiSettings: ankiDefaults.render,
      setNoteListColumns: listFields.setColumns,
    };
  };

  return { createSettingsDialogs };
});
