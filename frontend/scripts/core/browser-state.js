((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BrowserState = api;
})(globalThis, () => {
  // Mirrors `backend/anki-browser.js` SORT_FIELDS: a stored field the API would silently replace must never
  // be restored into the page either.
  const SORT_DIRECTIONS = ['asc', 'desc'];
  const DEFAULT_SORT_FIELD = 'createdAt';
  const DEFAULT_SORT_DIRECTION = 'desc';
  // A sort key is either one of Anki's own or the name of a note type field the table shows, so any short
  // non-empty name is kept: the fields a collection has are its own to decide, not this file's.
  const asSortField = value => (typeof value === 'string' && value.trim() && value.length <= 64
    ? value.trim() : DEFAULT_SORT_FIELD);

  const asText = value => (typeof value === 'string' ? value : '');
  const asId = value => {
    if (value === null || value === undefined || value === '') return null;
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
  };
  const asIds = value => [...new Set((Array.isArray(value) ? value : []).map(asId).filter(id => id !== null))];
  const asLabels = value => [...new Set((Array.isArray(value) ? value : [])
    .filter(label => typeof label === 'string' && label))];

  // Whatever the page stored is read back as a record the browser can apply as it stands: one bad field never
  // costs the others, and a record that cannot be trusted is replaced field by field instead of dropped whole.
  const normalize = raw => {
    const stored = raw && typeof raw === 'object' ? raw : {};
    const activeId = asId(stored.activeId);
    return {
      query: asText(stored.query),
      sortField: asSortField(stored.sortField),
      sortDirection: SORT_DIRECTIONS.includes(stored.sortDirection) ? stored.sortDirection : DEFAULT_SORT_DIRECTION,
      scrollTop: Number.isFinite(stored.scrollTop) && stored.scrollTop > 0 ? Math.round(stored.scrollTop) : 0,
      selectedIds: asIds(stored.selectedIds),
      activeId,
      // A new-note draft has no id to reload, so an editor that could not be reopened is not a state at all.
      editorOpen: stored.editorOpen === true && activeId !== null,
      collapsedGroups: asLabels(stored.collapsedGroups),
      quickSearchGroupOrder: asLabels(stored.quickSearchGroupOrder),
      sessionId: typeof stored.sessionId === 'string' && stored.sessionId ? stored.sessionId : null,
    };
  };

  const read = (storage, key) => {
    try { return normalize(JSON.parse(storage.getItem(key) || 'null')); }
    catch { return normalize(null); }
  };

  // A patch merges over the stored record, so a writer that owns one field (the chat's open session) never
  // drops the fields another one owns (the list's query, sort, selection) — they share one record.
  const write = (storage, key, patch) => {
    const next = normalize({ ...read(storage, key), ...patch });
    storage.setItem(key, JSON.stringify(next));
    return next;
  };

  return { DEFAULT_SORT_FIELD, SORT_DIRECTIONS, DEFAULT_SORT_DIRECTION, asSortField, normalize, read, write };
});
