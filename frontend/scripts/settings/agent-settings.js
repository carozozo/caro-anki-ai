((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroAgentSettings = api;
})(globalThis, () => {
  // The Agent panel: the enable switch, the configuration that is active, and the one form that creates, edits
  // and deletes configurations. It is one section of the settings dialog, so it owns only its own status line
  // and hands the dialog a load and a render.
  const createAgentSettings = ({
    $, CaroUI, request, state, setStatus, getAgentSettings, setAgentSettings, applyAgentAvailability,
  }) => {
    const { set: setSystemMessage } = CaroUI.status;
    const { armed: armedConfirm } = CaroUI.confirm;
    const { optionsHtml, pickerRow } = CaroUI.fields;

    const setAgentSettingsStatus = (text, kind = '') => setSystemMessage($('#agentSettingsStatus'), text, kind);
    const setAgentProfileFormStatus = (text, kind = '') =>
      setSystemMessage($('#agentProfileFormStatus'), text, kind);
    let previousManagedAgentProfileId = null;
    let agentProfileSaving = false;
    let agentProfilePickerMode = 'pick';
    let agentProfilePicker;
    const defaultLanguage = () => getAgentSettings().defaultLanguage || 'zh-TW';
    const renderAgentLanguages = () => $('#agentProfileLanguage')
      .html(optionsHtml(getAgentSettings().languages || []));

    const clearAgentProfileForm = () => {
      $('#agentProfileApiKey').val('');
      $('#agentProfileProvider').val('deepseek');
      $('#agentProfileModel').val('');
      $('#agentProfileBaseUrl').val('');
      $('#agentProfileEffort').val('auto');
      $('#agentProfileLanguage').val(defaultLanguage());
      $('#agentProfileStepLimit').val(12);
    };
    const agentProfileValues = name => ({
      name, provider: $('#agentProfileProvider').val(), model: $('#agentProfileModel').val(),
      baseUrl: $('#agentProfileBaseUrl').val(), reasoningEffort: $('#agentProfileEffort').val(),
      language: $('#agentProfileLanguage').val(),
      stepLimit: $('#agentProfileStepLimit').val(),
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
        $('#agentProfileLanguage').val(profile.language || defaultLanguage());
        $('#agentProfileStepLimit').val(profile.stepLimit);
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
      renderAgentLanguages();
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
        '#agentProfileLanguage',
        '#agentProfileStepLimit', '#agentProfileApiKey',
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

    return {
      load: loadAgentSettings,
      render: renderAgentSettings,
      setPanelStatus: setAgentSettingsStatus,
    };
  };

  return { createAgentSettings };
});
