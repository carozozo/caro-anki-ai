/* Frontend-only UI config. Never place API keys here — see backend/config.js. */
window.CARO_AI_UI_CONFIG = {
  locale: 'en-US',
  storageKeys: {
    chatCollapsed: 'anki-ai-chat-collapsed',
    pendingChat: 'anki-chat-pending',
    ankiBrowserWidths: 'anki-ai-browser-widths',
    // v6 positional widths migrate to keyed widths in NoteListColumns, so old user sizes stay with their fields.
    ankiNoteColumnWidths: 'anki-ai-note-column-widths-v6',
    ankiNoteColumnOrder: 'anki-ai-note-column-order-v1',
    ankiQuickSearchCollapsed: 'anki-ai-quick-search-collapsed',
    ankiQueryHistory: 'anki-ai-query-history',
    ankiShortcuts: 'anki-ai-shortcuts-v1',
    // The page's own state — query, sort, selection, open editor, scroll, ordered/folded quick-search groups,
    // and the open chat session — so a reload lands back in the view it left. Shape and validation live in
    // `frontend/scripts/core/browser-state.js`; nothing else may write this record field by field through it.
    ankiBrowserView: 'anki-ai-browser-view',
  },
  // `systemMessageMs` is how long a non-error system message stays visible; an error remains until its owner
  // clears or replaces it. `pendingDelayMs` is how long a `pending` sentence is held back: a write that lands
  // inside that window shows only its result, so a fast save never flashes "Saving…" on its way to "Saved."
  // `syncProgressMs` matches the bridge's own progress cadence (0.2s), so a stage or count Anki reports lands
  // in the transfer window within one poll of it being reported. `syncLingerMs` is the minimum a finished
  // sync holds its window for and `syncFadeMs` how long that window takes to fade once it lets go — together
  // they make the result readable when the sync itself was faster than the eye. A merge ends on the window's
  // own measurement of how long it took, so it can hold longer (see `holdSyncProgress`).
  // No request this app makes waits forever: `requestTimeoutMs` is the silence a request is allowed before
  // its deadline aborts it, and whatever proves the request is still alive re-arms that same deadline (the
  // sync with each progress poll, the chat stream with each event) — a plain route simply arms it once.
  // `streamIdleMs` is deliberately longer than the provider's own idle deadline on the backend, so a stalled
  // turn reports the failure the backend knows about before this side gives up on it. `markdownMs` is how long
  // the streamed answer bubble waits before it re-renders its markdown, so a fast reply does not pay for one
  // parse per token while the last token still lands on its own paint. `agentStopMs` is how long a run is left
  // alone before the way to stop it appears: a turn that answers quickly should never offer one.
  timings: {
    systemMessageMs: 3000, pendingDelayMs: 400, confirmArmMs: 3000, syncProgressMs: 200, syncLingerMs: 900,
    syncFadeMs: 250, requestTimeoutMs: 120000, streamIdleMs: 180000, viewPersistMs: 250, markdownMs: 120,
    agentStopMs: 15000 },
  // The `.is-closing` class the fade-out is styled by, set by `runAnkiSync` before it lets the window go.
  syncProgressClosing: 'is-closing',
  // Thinking budget for the Anki agent chat, chosen per request in the composer. `defaultReasoningEffort`
  // is the fallback until an Agent profile is selected; `auto` lets the backend classify the request and
  // pick the budget, which is why it is the default — a user should not have to guess how hard a request
  // is before sending it. Card writing lives in the agent turn, so an explicit value decides card and
  // translation quality — keep `auto` unless the user deliberately trades quality for latency.
  agentChat: {
    defaultReasoningEffort: 'auto',
    reasoningEfforts: [
      { value: 'none', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'auto', label: 'Auto' },
    ],
  },
  ankiBrowser: {
    notePreviewLength: 120,
    // The page a card really runs in is not only its template: Anki renders it in a webview that already
    // carries jQuery, and every template's script is written against `$`. The card preview frame rebuilds
    // that page, so it loads the same build this app itself boots with (`frontend/scripts/bootstrap.js`).
    cardPreview: { scriptSrc: 'https://code.jquery.com/jquery-3.7.1.min.js' },
    queryHistoryLimit: 15,
    panelResizer: { handle: 6, minQuick: 150, minChat: 260, minContent: 280, keyStep: 10, keyStepFast: 40 },
    noteList: { columnMin: 80, rowHeight: 42, overscan: 10, pageSize: 250 },
    // Stable group ids keep a user's order when labels change or a later version adds a group. Dynamic sources
    // build `<prefix>:<value>` queries; visible decks remain the user's setting, never a name filter here.
    quickSearchGroups: [
      { id: 'recent', label: 'RECENT', values: [
        { text: 'Added today', query: 'added:1' },
        { text: 'Added 7 days', query: 'added:7' },
        { text: 'Edited 7 days', query: 'edited:7' },
        { text: 'Rated 7 days', query: 'rated:7' },
        { text: 'Introduced 30 days', query: 'introduced:30' },
      ] },
      { id: 'card-state', label: 'CARD STATE', values: [
        { text: 'New', query: 'is:new' },
        { text: 'Learning', query: 'is:learn' },
        { text: 'Due', query: 'is:due' },
        { text: 'Review', query: 'is:review' },
        { text: 'Suspended', query: 'is:suspended' },
        { text: 'Buried', query: 'is:buried' },
      ] },
      { id: 'flags', label: 'FLAGS', values: [
        { text: 'Red', query: 'flag:1', flag: 1 },
        { text: 'Orange', query: 'flag:2', flag: 2 },
        { text: 'Green', query: 'flag:3', flag: 3 },
        { text: 'Blue', query: 'flag:4', flag: 4 },
        { text: 'Pink', query: 'flag:5', flag: 5 },
        { text: 'Teal', query: 'flag:6', flag: 6 },
        { text: 'Purple', query: 'flag:7', flag: 7 },
      ] },
      { id: 'note-types', label: 'NOTE TYPES', source: 'models', prefix: 'note', quote: true },
      { id: 'decks', label: 'DECKS', source: 'decks', prefix: 'deck', quote: true },
      { id: 'tags', label: 'TAGS', source: 'tags', prefix: 'tag', quote: true },
    ],
  },
};
