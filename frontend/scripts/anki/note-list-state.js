((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteListState = api;
})(globalThis, () => {
  // `update_note` is the current name; `update` is what a conversation persisted before the tool names were
  // namespaced carries, and an old session must still refresh the rows it edited.
  const UPDATE_TOOLS = new Set(['update_note', 'update']);

  const updatedNoteIds = operations => [...new Set((operations || [])
    .filter(({ action, status, result }) => UPDATE_TOOLS.has(action?.name) && status === 'completed' && result?.id)
    .map(({ result }) => Number(result.id)))];

  // An update is a read of the server's own fields, so it is merged onto the note it replaces: a field the
  // read did not ask for keeps the value the row is showing instead of blanking the column it feeds.
  const mergeUpdatedNotes = (notes, updates) => {
    const byId = new Map(updates.filter(Boolean).map(note => [note.id, note]));
    return notes.map(note => (byId.has(note.id) ? { ...note, ...byId.get(note.id) } : note));
  };

  const selectedNotesInOrder = (notes, selectedIds) => {
    const byId = new Map(notes.map(note => [note.id, note]));
    return [...selectedIds].map(id => byId.get(id)).filter(Boolean);
  };

  // The row a bare ArrowUp/ArrowDown enters while nothing is selected: the row on screen nearest the
  // remembered selection, and for a list that was never selected in, the first row on screen. Clamping to
  // the on-screen window (`visibleRange` with no overscan, `end` exclusive) means entering a long list
  // never jumps to an end far away from where the user is looking.
  const selectionEntryIndex = (total, rememberedIndex, key, visible) => {
    if (total <= 0) return -1;
    const last = total - 1;
    const first = Math.max(0, Math.min(last, visible.first));
    const end = Math.max(first + 1, Math.min(total, visible.end));
    if (!Number.isInteger(rememberedIndex)) return first;
    return Math.max(first, Math.min(end - 1, rememberedIndex + (key === 'ArrowUp' ? -1 : 1)));
  };

  const visibleRange = (total, scrollTop, viewportHeight, rowHeight, overscan) => {
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const count = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
    return { first, end: Math.min(total, first + count) };
  };

  const scrollTopForIndex = (index, scrollTop, viewportHeight, rowHeight) => {
    const rowTop = index * rowHeight;
    const rowBottom = (index + 2) * rowHeight;
    if (rowTop < scrollTop) return rowTop;
    if (rowBottom > scrollTop + viewportHeight) return rowBottom - viewportHeight;
    return scrollTop;
  };

  return {
    mergeUpdatedNotes, scrollTopForIndex, selectedNotesInOrder, selectionEntryIndex, updatedNoteIds, visibleRange,
  };
});
