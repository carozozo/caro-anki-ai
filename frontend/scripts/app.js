(($, config) => {
  // The document's language is the app's own locale, stated once in the UI config, so the metadata and the
  // date and number formatting the page actually uses can never drift apart the way they would if the
  // language were written into the HTML.
  document.documentElement.lang = config.locale;
  // Every shared control primitive comes from the UI kit; app.js only wires them to this page.
  const UI = window.CaroUI;
  const { escapeHtml } = UI.text;
  const { optionsHtml } = UI.fields;
  const { armed: armedConfirm } = UI.confirm;
  const { create: createDialog, isOpen: isDialogOpen } = UI.dialogs;
  const { set: setSystemMessage } = UI.status;
  // A response is read by the stream's own rules, so its reader is the one ChatStream piece this page still
  // needs: the chat controller is handed the whole module.
  const { readEvents } = window.ChatStream;
  const NoteShortcuts = window.NoteShortcuts;
  const desktop = window.CaroDesktop || {
    onMenuCommand: () => () => {}, updateMenuState: () => {}, updateMenuShortcuts: () => {},
  };
  NoteShortcuts.restore(localStorage, config.storageKeys.ankiShortcuts);
  const desktopAccelerator = ({ key, code, shift, alt }) => {
    const acceleratorKey = {
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space',
    }[key] || { BracketLeft: '[', BracketRight: ']' }[code] || key;
    const normalizedKey = acceleratorKey.length === 1 ? acceleratorKey.toUpperCase() : acceleratorKey;
    return ['CommandOrControl', alt && 'Alt', shift && 'Shift', normalizedKey].filter(Boolean).join('+');
  };
  const syncDesktopMenuShortcuts = () => desktop.updateMenuShortcuts(Object.fromEntries(
    NoteShortcuts.definitions.map(shortcut => [shortcut.id, desktopAccelerator(shortcut)]),
  ));
  syncDesktopMenuShortcuts();
  const ANKI_BROWSER_VIEW_KEY = config.storageKeys.ankiBrowserView;
  // The view a reload lands back in. Every writer patches the one record through `BrowserState`, so the chat's
  // open session and the note list's own state never overwrite each other.
  const readBrowserView = () => BrowserState.read(localStorage, ANKI_BROWSER_VIEW_KEY);
  const writeBrowserView = patch => BrowserState.write(localStorage, ANKI_BROWSER_VIEW_KEY, patch);
  // The conversation the window was left reading, taken before anything renders: the boot's own `showSessions()`
  // patches the same record with `null`, so a read taken after it could only ever see the session list.
  const openedSessionId = readBrowserView().sessionId;
  // The composer's own placeholder, captured before a pinned skill's hint can replace it.
  const composerPlaceholder = $('#messageInput').attr('placeholder') || '';

  // The thinking budget belongs to the request: UI config supplies the fallback, selecting an Agent applies
  // that profile's default, and the chosen value travels with every chat request (a retry included).
  const reasoningEfforts = config.agentChat.reasoningEfforts;
  const defaultReasoningEffort = config.agentChat.defaultReasoningEffort;
  const initReasoningEffort = () => {
    const chosen = reasoningEfforts.some(option => option.value === defaultReasoningEffort)
      ? defaultReasoningEffort : reasoningEfforts[0].value;
    $('#reasoningEffort').html(optionsHtml(reasoningEfforts)).val(chosen);
  };
  const state = { sessions: [], activeSessionId: null, busy: false, pending: null, selection: [] };
  let agentSettings = { enabled: false, activeProfileId: null, defaultLanguage: 'zh-TW', languages: [], profiles: [] };
  const getAgentSettings = () => agentSettings;
  const setAgentSettings = settings => { agentSettings = settings; };
  // The pending record is the composer's armed request: the text, the note selection and the effort a turn
  // was sent with, plus the conversation that turn belongs to. It is kept so the turn can be resumed or
  // ended, never so a later click can retarget it, and its own `sessionId` is what says where it goes.
  const readPendingChat = () => {
    try { return JSON.parse(sessionStorage.getItem(config.storageKeys.pendingChat) || 'null'); }
    catch { return null; }
  };
  const clearPendingChat = () => sessionStorage.removeItem(config.storageKeys.pendingChat);
  // The status pill carries one line: the connection state, or the pending-sync reminder while the
  // connection is healthy. An error outranks the reminder, so the pill never hides a transient result — and
  // because each writer only records its input and re-derives, the order the two resolve in does not matter.
  // A sync in flight does NOT write here at all: what it is doing lives in its own transfer window, and the
  // one line keeps describing the connection. The pill is hidden on narrow viewports, so the full message
  // also lives in the title.
  const SYNC_REMINDER = { pill: 'Unsynced changes', hint: 'Unsynced changes — sync with AnkiWeb' };
  // The healthy baseline of the pill: a sync that has nothing worth reporting puts it back here, because a
  // normal sync's outcome is silence and the one line has to keep describing the connection.
  const CONNECTED_STATUS = 'Connected';
  const connectionStatus = {
    kind: 'pending', text: 'Checking connection', needsSync: false, required: 'NO_CHANGES',
  };
  const renderStatus = () => {
    const { kind, text, needsSync } = connectionStatus;
    const reminder = needsSync && kind === 'ok';
    setSystemMessage($('#connectionStatus'), reminder ? SYNC_REMINDER.pill : text, reminder ? 'warn' : kind,
      { persistent: true })
      .attr('title', reminder ? SYNC_REMINDER.hint : text);
  };
  const setStatus = (kind, text) => {
    Object.assign(connectionStatus, { kind, text });
    renderStatus();
  };
  // Every request this page makes goes through one client: a plain route arms its own deadline, a streamed
  // chat request re-arms one per event, and every Anki write announces itself so the sync status re-reads.
  const api = window.CaroApiClient.createClient({
    config,
    readEvents,
    onAnkiMutation: () => refreshSyncStatus(),
  });
  const { request } = api;
  // The composer, the conversation and the session list are one controller's business; this page keeps only
  // its own state, the request paths it makes, and the wiring that turns a finished turn into a re-read.
  const chat = window.CaroChatController.createChatController({
    $,
    config,
    CaroUI: UI,
    CaroMarkdown: window.CaroMarkdown,
    ChatStream: window.ChatStream,
    SkillMenu: window.SkillMenu,
    NoteShortcuts,
    request,
    streamChatRequest: api.streamChatRequest,
    state,
    getAgentSettings: () => agentSettings,
    writeBrowserView,
    readPendingChat,
    clearPendingChat,
    setStatus,
    defaultReasoningEffort,
    composerPlaceholder,
  });
  const { focusChatComposer, loadSession, loadSessions, renderChatMode, renderComposerState,
    setChatStatus, setMessageInput, showSessions } = chat;
  const applyAgentAvailability = () => {
    const active = agentSettings.profiles.find(profile => profile.id === agentSettings.activeProfileId);
    const available = agentSettings.enabled && Boolean(active);
    const hasProfiles = Boolean(agentSettings.profiles.length);
    $('#agentDisabledPanel').prop('hidden', agentSettings.enabled);
    $('#agentChatWorkspace').prop('hidden', !agentSettings.enabled);
    $('#composerTools').prop('hidden', !hasProfiles);
    $('#agentName').html(optionsHtml(agentSettings.profiles, {
      value: profile => profile.id,
      label: profile => profile.name,
    })).val(agentSettings.activeProfileId);
    if (active) $('#reasoningEffort').val(active.reasoningEffort);
    renderComposerState();
    renderChatMode();
    if (!agentSettings.enabled) setChatStatus('');
    else if (!available) setChatStatus('Anki Agent is unavailable.', 'warn');
    else if (!state.pending) setChatStatus('');
  };
  // The AnkiWeb account, the sync it authorizes and the transfer window that reports it are one
  // controller: the account state is what both the sync button and the settings dialog read, and the sync
  // is the only writer of the pill's outcome.
  const sync = window.CaroSyncController.createSyncController({
    $,
    config,
    CaroUI: UI,
    request,
    armDeadline: api.armDeadline,
    CONNECTED_STATUS,
    SYNC_REMINDER,
    state,
    connectionStatus,
    setStatus,
    renderStatus,
    // The Anki settings panel is created after this controller and answers for the account state, so both
    // ends of the circle are read lazily rather than at construction.
    getAnkiSettingsState: () => settings?.getAnkiSettingsState(),
    loadAnkiSettings: () => settings.loadAnkiSettings(),
    NoteShortcuts,
  });
  const { refreshSyncStatus, renderAnkiAccountButton } = sync;
  // An agent turn writes through the chat route rather than an /api/anki one, so it announces itself the
  // same way this UI announces any other collection change: the reminder is re-read once the run ends.
  $(document).on('anki-agent-finished', () => { refreshSyncStatus(); });
  // Settings are one controller's business: the Agent configurations, the Anki defaults and the Library all
  // read and write through the same dialog, and it reads the account state the sync controller publishes.
  const settings = window.CaroSettingsDialogs.createSettingsDialogs({
    $,
    CaroUI: UI,
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
    // The dialog is the shell around one module per panel; app.js only hands the factories over, and the
    // library's name helpers travel with them because the editor is the only module that reads a stored name.
    libraryNames: window.CaroSettingsLibraryNames,
    panels: {
      agent: window.CaroAgentSettings.createAgentSettings,
      ankiDefaults: window.CaroAnkiDefaults.createAnkiDefaults,
      ankiMaintenance: window.CaroAnkiMaintenance.createAnkiMaintenance,
      ankiProfiles: window.CaroAnkiProfiles.createAnkiProfiles,
      listFields: window.CaroListFields.createListFields,
      library: window.CaroLibraryEditor.createLibraryEditor,
      shortcuts: window.CaroShortcutSettings.createShortcutSettings,
    },
  });
  const { getAnkiSettingsState, getAnkiModelChoices, loadAgentSettings, loadAnkiSettings,
    setAnkiModelChoices } = settings;
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const renderShortcutLabels = () => {
    const labels = {
      settings: 'Anki settings', agent: 'Agent name', effort: 'Reasoning effort',
      'focus-chat': 'Agent message', 'focus-query': 'Card search',
      'toggle-quick-search': 'Toggle quick search', 'toggle-chat': 'Toggle Anki Agent', 'send-chat': 'Send',
    };
    Object.entries(labels).forEach(([id, label]) => {
      const shortcut = NoteShortcuts.find(id);
      $(shortcut.selector).attr({
        'aria-keyshortcuts': NoteShortcuts.aria(shortcut),
        'aria-label': `${label} (${NoteShortcuts.display(shortcut, isMac)})`,
        title: `${label} (${NoteShortcuts.display(shortcut, isMac)})`,
      });
    });
  };
  renderShortcutLabels();
  $(document).on('anki-shortcuts-changed', () => {
    renderShortcutLabels();
    syncDesktopMenuShortcuts();
  });
  const appShortcutActions = {
    account: () => $('#ankiAccountOpen').trigger('click'),
    sync: () => $('#syncAnki').trigger('click'),
    settings: () => $('#ankiSettingsOpen').trigger('click'),
    agent: () => $('#agentName').trigger('focus'),
    effort: () => $('#reasoningEffort').trigger('focus'),
    'focus-chat': focusChatComposer,
    'focus-query': () => $('#ankiQuery').trigger('focus'),
    'toggle-quick-search': () => $('#toggleAnkiQuickSearch').trigger('click'),
    'toggle-chat': () => $('#collapseChat').trigger('click'),
  };
  const activateMenuControl = selector => {
    const $control = $(selector);
    if (!$control.prop('disabled') && !$control.prop('hidden')) $control.trigger('click');
  };
  const focusMenuControl = selector => {
    const $control = $(selector);
    if (!$control.prop('disabled') && !$control.prop('hidden')) $control.trigger('focus');
  };
  let deleteMenuTimer;
  const updateDeleteMenuArm = () => {
    const armed = $('#ankiSelectedDelete').hasClass('button-danger');
    desktop.updateMenuState({ 'selected-delete-armed': armed });
    window.clearTimeout(deleteMenuTimer);
    if (armed) deleteMenuTimer = window.setTimeout(() => {
      desktop.updateMenuState({ 'selected-delete-armed': false });
    }, config.timings.confirmArmMs);
  };
  const menuActions = {
    account: () => activateMenuControl('#ankiAccountOpen'),
    sync: () => activateMenuControl('#syncAnki'),
    settings: () => activateMenuControl('#ankiSettingsOpen'),
    'focus-query': () => focusMenuControl('#ankiQuery'),
    'new-note': () => activateMenuControl('#ankiNewNote'),
    'study-options': () => activateMenuControl('#ankiStudyOptions'),
    'note-type': () => activateMenuControl('#ankiEditNoteType'),
    decks: () => activateMenuControl('#ankiManageDecks'),
    tags: () => activateMenuControl('#ankiManageTags'),
    preview: () => activateMenuControl('#ankiPreviewNote'),
    'find-replace': () => activateMenuControl('#ankiFindReplace'),
    'selected-search': () => activateMenuControl('#ankiSelectedSearch'),
    'selected-copy': () => activateMenuControl('#ankiSelectedCopy'),
    'selected-change-deck': () => activateMenuControl('#ankiChangeDeck'),
    'selected-set-due': () => activateMenuControl('#ankiSetDueDate'),
    'selected-send-agent': () => activateMenuControl('#ankiSelectedAi'),
    'selected-delete': () => activateMenuControl('#ankiSelectedDelete'),
    'focus-chat': focusChatComposer,
    'toggle-chat': () => activateMenuControl('#collapseChat'),
  };
  desktop.onMenuCommand(command => {
    if (isDialogOpen()) return;
    const action = menuActions[command];
    if (action) action();
    if (command === 'selected-delete') updateDeleteMenuArm();
  });
  document.addEventListener('keydown', event => {
    // A modal owns the keyboard while it is open: the transfer window cannot be dismissed, so a shortcut
    // firing behind it could only stack another dialog on top of a collection that is being replaced.
    if (event.defaultPrevented || isDialogOpen()) return;
    const shortcut = NoteShortcuts.definitions.find(item => item.scope === 'app'
      && NoteShortcuts.matches(event, item));
    const action = shortcut && appShortcutActions[shortcut.id];
    if (!action) return;
    event.preventDefault();
    action();
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.key !== 'Escape' || !state.activeSessionId) return;
    event.preventDefault();
    $('#chatSessions').trigger('click');
  });
  const checkHealth = async () => {
    try {
      await request('/api/health');
      setStatus('ok', CONNECTED_STATUS);
      await loadSessions();
      // A reload may remember an armed request, but only for a conversation that still exists: an armed request
      // is resolved by resending it or ending it, and neither is possible against a session that is gone. The
      // record's own `sessionId` is what makes that check, which is why it is stored beside the request.
      const pending = readPendingChat();
      if (pending?.sessionId && state.sessions.some(session => session.id === pending.sessionId)) {
        state.pending = pending;
      } else clearPendingChat();
      const restoreId = state.pending?.sessionId || openedSessionId;
      if (restoreId && state.sessions.some(session => session.id === restoreId)) {
        // A conversation the window was reading reopens with it; one deleted elsewhere falls back to the
        // session list instead of failing the page.
        try { await loadSession(restoreId); } catch { showSessions(); }
      }
      if (state.pending) setMessageInput(state.pending.content || '');
      // One funnel renders the armed request's controls, so a reload cannot restore the record without also
      // restoring the two ways out of it: the button that resends it and the one that ends it.
      renderComposerState();
    } catch (error) {
      setStatus('error', error.message);
      $('#sessionList').html(`<div class="empty-state compact">${escapeHtml(error.message)}</div>`);
    }
  };
  // The Anki browser is its own module: this page hands it the kit, the client and the settings the user
  // chose, and it owns every part of the collection's own panel from there. Its widgets are modules too, so
  // they are handed over the same way.
  const initAnkiBrowser = () => window.CaroAnkiBrowser.initAnkiBrowser({
    $,
    config,
    desktop,
    CaroUI: UI,
    NoteListState,
    NoteSelection,
    NoteShortcuts,
    CardDocument,
    BrowserPanels,
    QueryHistory,
    QuickSearch,
    NoteListColumns,
    NoteListView,
    StudyOptionsDialog,
    DeckStudio,
    TagStudio,
    NoteTypeStudio,
    CardPreview,
    BatchDialog,
    FindReplaceDialog,
    NoteListInput,
    NoteEditor,
    NoteBrowserState,
    request,
    state,
    readBrowserView,
    writeBrowserView,
    armedConfirm,
    createDialog,
    isDialogOpen,
    loadAnkiSettings,
    getAnkiSettingsState,
    getAnkiModelChoices,
    setAnkiModelChoices,
  });

  initReasoningEffort();
  loadAgentSettings().catch(error => setStatus('error', error.message));
  loadAnkiSettings().catch(error => setStatus('error', error.message));
  refreshSyncStatus();
  checkHealth();
  showSessions();
  // The browser builds the note list's column controller, and Quick settings' List Fields panel writes through
  // that one controller, so it is handed over once the browser exists.
  settings.setNoteListColumns(initAnkiBrowser()?.noteListColumns);
})(jQuery, window.CARO_AI_UI_CONFIG);
