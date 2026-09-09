((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteShortcuts = api;
})(globalThis, () => {
  const defaults = [
    { id: 'undo', scope: 'browser', selector: '#ankiUndo', key: '[', alt: true, label: 'Undo' },
    { id: 'redo', scope: 'browser', selector: '#ankiRedo', key: ']', alt: true, label: 'Redo' },
    { id: 'first', scope: 'browser', selector: '#ankiFirstNote', key: '[', shift: true, code: 'BracketLeft',
      label: 'First note' },
    { id: 'previous', scope: 'browser', selector: '#ankiPreviousNote', key: '[', label: 'Previous note' },
    { id: 'next', scope: 'browser', selector: '#ankiNextNote', key: ']', label: 'Next note' },
    { id: 'last', scope: 'browser', selector: '#ankiLastNote', key: ']', shift: true, code: 'BracketRight',
      label: 'Last note' },
    { id: 'search', scope: 'browser', selector: '#ankiSelectedSearch', key: 's', label: 'Search selected notes' },
    { id: 'ai', scope: 'browser', selector: '#ankiSelectedAi', key: 'g', label: 'Send selected notes to AI chat' },
    { id: 'copy', scope: 'browser', selector: '#ankiSelectedCopy', key: 'c', label: 'Copy selected notes' },
    { id: 'delete', scope: 'browser', selector: '#ankiSelectedDelete', key: 'Backspace',
      label: 'Delete selected notes; press twice' },
    { id: 'deck', scope: 'browser', selector: '#ankiChangeDeck', key: 'd', label: 'Change deck' },
    { id: 'due', scope: 'browser', selector: '#ankiSetDueDate', key: 'u', label: 'Set due time' },
    { id: 'new', scope: 'browser', selector: '#ankiNewNote', key: 'n', label: 'New note' },
    { id: 'study-options', scope: 'browser', selector: '#ankiStudyOptions', key: 'o', shift: true,
      label: 'Open study options' },
    { id: 'note-type', scope: 'browser', selector: '#ankiEditNoteType', key: 'n', shift: true,
      label: 'Open note type studio' },
    { id: 'manage-decks', scope: 'browser', selector: '#ankiManageDecks', key: 'd', shift: true,
      label: 'Open deck studio' },
    { id: 'manage-tags', scope: 'browser', selector: '#ankiManageTags', key: 't', shift: true,
      label: 'Manage tags' },
    { id: 'preview', scope: 'browser', selector: '#ankiPreviewNote', key: 'v', shift: true,
      label: 'Preview selected note' },
    ...['Red', 'Orange', 'Green', 'Blue', 'Pink', 'Teal', 'Purple'].map((color, index) => ({
      id: `flag-${index + 1}`, scope: 'browser', action: 'flag', flag: index + 1, key: String(index + 1),
      label: `Set or clear ${color.toLowerCase()} flag`,
    })),
    { id: 'select-all', scope: 'browser', action: 'select-all', key: 'a', label: 'Select all notes' },
    { id: 'toggle-html', scope: 'browser', action: 'toggle-html', key: 'x', shift: true,
      label: 'Toggle HTML editor' },
    { id: 'account', scope: 'app', selector: '#ankiAccountOpen', key: 'l', shift: true,
      label: 'Open AnkiWeb account' },
    { id: 'sync', scope: 'app', selector: '#syncAnki', key: 'y', shift: true, label: 'Sync with AnkiWeb' },
    { id: 'settings', scope: 'app', selector: '#ankiSettingsOpen', key: 's', shift: true,
      label: 'Open settings' },
    { id: 'agent', scope: 'app', selector: '#agentName', key: 'a', shift: true, label: 'Focus Agent selector' },
    { id: 'effort', scope: 'app', selector: '#reasoningEffort', key: 'e', shift: true,
      label: 'Focus reasoning effort selector' },
    { id: 'focus-chat', scope: 'app', selector: '#messageInput', key: 'g', shift: true,
      label: 'Focus agent message' },
    { id: 'focus-query', scope: 'app', selector: '#ankiQuery', key: 'f', label: 'Focus card search' },
    { id: 'toggle-quick-search', scope: 'app', selector: '#toggleAnkiQuickSearch', key: 'q', alt: true,
      label: 'Toggle quick search' },
    { id: 'toggle-chat', scope: 'app', selector: '#collapseChat', key: 'g', alt: true,
      label: 'Toggle Anki Agent' },
    { id: 'send-chat', scope: 'chat', selector: '.composer-submit', key: 'Enter', label: 'Send agent message' },
  ];
  const previewTargets = {
    first: { previewSelector: '#ankiPreviewFirst', previewLabel: 'First preview' },
    previous: { previewSelector: '#ankiPreviewPrevious', previewLabel: 'Previous preview' },
    next: { previewSelector: '#ankiPreviewNext', previewLabel: 'Next preview' },
    last: { previewSelector: '#ankiPreviewLast', previewLabel: 'Last preview' },
  };
  const normalizedKey = key => key.length === 1 ? key.toLowerCase() : key;
  const binding = ({ key, code = '', shift = false, alt = false }) => ({ key, code, shift, alt });
  const defaultBinding = shortcut => binding(shortcut);
  const definitions = defaults.map(shortcut => ({ ...shortcut, ...previewTargets[shortcut.id] }));
  const find = id => definitions.find(shortcut => shortcut.id === id);
  const defaultFor = id => defaults.find(shortcut => shortcut.id === id);
  const sameBinding = (left, right) => ['key', 'code', 'shift', 'alt']
    .every(key => binding(left)[key] === binding(right)[key]);
  const validBinding = value => value && typeof value === 'object' && typeof value.key === 'string'
    && value.key.length > 0 && typeof value.code === 'string' && typeof value.shift === 'boolean'
    && typeof value.alt === 'boolean';
  const normalizedBinding = value => ({ ...value, key: normalizedKey(value.key) });
  const apply = (shortcut, value) => Object.assign(shortcut, normalizedBinding(value));
  const reset = id => {
    const shortcut = find(id);
    const fallback = defaultFor(id);
    if (!shortcut || !fallback) throw new Error(`Unknown shortcut: ${id}`);
    return apply(shortcut, defaultBinding(fallback));
  };
  const update = (id, value) => {
    if (!validBinding(value)) throw new Error('A shortcut must include a key and modifiers');
    const shortcut = find(id);
    if (!shortcut) throw new Error(`Unknown shortcut: ${id}`);
    return apply(shortcut, value);
  };
  const resetAll = () => definitions.forEach(shortcut => reset(shortcut.id));
  const overrides = () => Object.fromEntries(definitions.flatMap(shortcut => {
    const fallback = defaultFor(shortcut.id);
    return sameBinding(shortcut, fallback) ? [] : [[shortcut.id, binding(shortcut)]];
  }));
  const restore = (storage, key) => {
    let saved = {};
    try {
      const parsed = JSON.parse(storage.getItem(key) || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
    } catch { /* An invalid local preference simply returns to the documented defaults. */ }
    resetAll();
    definitions.forEach(shortcut => {
      if (validBinding(saved[shortcut.id])) update(shortcut.id, saved[shortcut.id]);
    });
    return definitions;
  };
  const persist = (storage, key) => {
    const saved = overrides();
    if (Object.keys(saved).length) storage.setItem(key, JSON.stringify(saved));
    else storage.removeItem(key);
    return saved;
  };
  const physicalKey = event => {
    if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
    if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
    return { BracketLeft: '[', BracketRight: ']' }[event.code] || normalizedKey(event.key);
  };
  // macOS Option changes `event.key` to a character such as œ or ©. Letter and digit bindings therefore use
  // the physical key, as do the shifted bracket bindings.
  const matches = (event, shortcut) => (event.metaKey || event.ctrlKey)
    && Boolean(event.altKey) === Boolean(shortcut.alt)
    && Boolean(event.shiftKey) === Boolean(shortcut.shift)
    && (shortcut.code ? event.code === shortcut.code
      : physicalKey(event) === normalizedKey(shortcut.key));
  const isEditable = target => target instanceof Element
    && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
  const keyLabel = key => key.length === 1 ? key.toUpperCase() : key;
  const modifierLabel = (shortcut, isMac) => `${isMac ? '⌘' : 'Ctrl'} + ${shortcut.alt ? 'Alt + ' : ''}`
    + `${shortcut.shift ? 'Shift + ' : ''}`;
  const display = (shortcut, isMac) => `${modifierLabel(shortcut, isMac)}${keyLabel(shortcut.key)}`;
  const aria = shortcut => ['Meta+', 'Control+'].map(prefix => `${prefix}${shortcut.alt ? 'Alt+' : ''}`
    + `${shortcut.shift ? 'Shift+' : ''}${keyLabel(shortcut.key)}`).join(' ');
  const capture = event => {
    if ((!event.metaKey && !event.ctrlKey) || event.isComposing
      || ['Alt', 'Control', 'Meta', 'Shift', 'Dead'].includes(event.key)) return null;
    const key = physicalKey(event);
    if (!key) return null;
    return { key, code: event.shiftKey && !/^Key[A-Z]$/.test(event.code) ? event.code : '',
      shift: Boolean(event.shiftKey), alt: Boolean(event.altKey) };
  };

  return {
    aria, binding, capture, defaultFor, definitions, display, find, isEditable, matches, overrides, persist,
    reset, resetAll, restore, sameBinding, update,
  };
});
