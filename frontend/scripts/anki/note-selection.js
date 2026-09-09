((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NoteSelection = api;
})(globalThis, () => {
  // A selection is the ids the page acts on plus one anchor, the row an extension measures its range from.
  // Every gesture that changes it resolves here — a click, an arrow, ⌘A, Esc, a preview step, opening the
  // editor — and every resolver answers with the same shape: `{ ids, anchorId, focusId }`, where `focusId` is
  // the row to reveal and focus, and null when the gesture has no row of its own.

  // The ids between the anchor and the target, in the direction the target lies: shifting down from row 1 to
  // row 3 selects 1,2,3 and shifting up from 3 to 1 selects 3,2,1, so the page always extends from the anchor
  // outward instead of jumping to an end.
  const idsBetween = (notes, anchorId, targetId) => {
    const anchorIndex = notes.findIndex(note => note.id === anchorId);
    const targetIndex = notes.findIndex(note => note.id === targetId);
    if (anchorIndex < 0) return [targetId];
    const range = notes.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
    return (anchorIndex <= targetIndex ? range : range.reverse()).map(note => note.id);
  };

  const none = (focusId = null) => ({ ids: [], anchorId: null, focusId });

  // The selection a note owns on its own: what the editor holds, and what Chat is left with when the composer
  // chip is cleared while a note is being edited.
  const single = id => ({ ids: [id], anchorId: id, focusId: null });

  // The rows a freshly loaded list may keep. An id the result no longer holds is dropped, and the anchor goes
  // with it because a range measured in the old list has nothing left to measure against.
  const containedIn = (notes, { ids }) => {
    const present = new Set(notes.map(note => note.id));
    return { ids: ids.filter(id => present.has(id)), anchorId: null, focusId: null };
  };

  // Shift extends from the anchor toward the target; with the primary modifier the range is added to what is
  // already selected instead of replacing it. An unanchored range starts at the target itself, which is the
  // single row a first shift-click selects.
  const click = (notes, { ids, anchorId }, targetId, { metaKey, shiftKey }) => {
    if (shiftKey) {
      const range = idsBetween(notes, anchorId, targetId);
      return {
        ids: [...new Set(metaKey ? [...ids, ...range] : range)],
        anchorId: anchorId ?? targetId,
        focusId: targetId,
      };
    }
    // A plain click on a selected row drops it and leaves the selection unanchored, which is the state the
    // arrows re-enter a list from; with the primary modifier the anchor stays on the row that was just toggled,
    // so the next extension measures from it.
    if (ids.includes(targetId)) {
      return { ids: ids.filter(id => id !== targetId), anchorId: metaKey ? targetId : null, focusId: targetId };
    }
    return metaKey
      ? { ids: [...ids, targetId], anchorId: targetId, focusId: targetId }
      : { ids: [targetId], anchorId: targetId, focusId: targetId };
  };

  // The arrows step one row from the row the key came from while something is selected, and otherwise enter
  // the list at the row the page was last at. `entryIndex` is a thunk because finding that row reads the
  // scroll viewport — a layout read a step with a selection on screen has no reason to pay for.
  const move = (notes, { ids, anchorId }, { focusedId, entryIndex, key, extend }) => {
    const step = key === 'ArrowUp' ? -1 : 1;
    const nextIndex = ids.length
      ? Math.max(0, Math.min(notes.length - 1, notes.findIndex(note => note.id === focusedId) + step))
      : entryIndex();
    if (nextIndex < 0) return null;
    const nextId = notes[nextIndex].id;
    // A step with nothing to extend from — the selection is empty, or an extension is asked for by a key that
    // came from a row outside the selection — selects the row it moved to and makes that row the anchor.
    const from = extend ? (anchorId ?? focusedId) : null;
    if (from === null || !notes.some(note => note.id === from)) {
      return { ids: [nextId], anchorId: nextId, focusId: nextId };
    }
    return { ids: idsBetween(notes, from, nextId), anchorId: from, focusId: nextId };
  };

  // ⌘A takes the whole result. The anchor only moves when the selection had none, so a shift+arrow pressed
  // right after a select-all still extends from the row the user was last on.
  const all = (notes, { ids, anchorId }, focusId = null) => ({
    ids: [...new Set([...ids, ...notes.map(note => note.id)])],
    anchorId: anchorId ?? focusId ?? notes[0].id,
    focusId,
  });

  // A landing is any gesture that goes to the note at an index: a preview step, ⌘↑/⌘↓, First/Last, or opening
  // the editor on a row. The editor decides what one means, because while it is open it is what the page
  // shows — no list is on screen to select a row in. So a landing is then a move of the editor, the selection
  // following the note the editor took (it is always exactly that note), and landing on the note already being
  // edited is a no-op. That no-op is what keeps a caret that is being typed in, and it holds for a draft too,
  // whose editor has no id to compare against.
  const landing = (notes, { ids, anchorId }, index, editor = { open: false, id: null }) => {
    const next = notes[index];
    if (!next) return { changed: false, ids, anchorId, focusId: null, editorId: null };
    if (editor.open) {
      if (editor.id === next.id) return { changed: false, ids, anchorId, focusId: null, editorId: null };
      return { changed: true, ids: [next.id], anchorId: next.id, focusId: null, editorId: next.id };
    }
    if (ids.length === 1 && ids[0] === next.id) {
      return { changed: false, ids, anchorId, focusId: null, editorId: null };
    }
    return { changed: true, ids: [next.id], anchorId: next.id, focusId: next.id, editorId: null };
  };

  return { all, click, containedIn, landing, move, none, single };
});
