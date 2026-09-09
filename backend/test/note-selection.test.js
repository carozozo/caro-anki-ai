const test = require('node:test');
const assert = require('node:assert/strict');
const { all, click, containedIn, landing, move, none, single } =
  require('../../frontend/scripts/anki/note-selection');

const notes = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
const at = (...ids) => ({ ids, anchorId: ids.length ? ids[0] : null });
const idsOf = patch => patch.ids;

test('a plain click replaces the selection and anchors the row it landed on', () => {
  const patch = click(notes, at(1), 3, {});

  assert.deepEqual(patch.ids, [3]);
  assert.equal(patch.anchorId, 3);
  assert.equal(patch.focusId, 3);
});

test('a plain click on a selected row drops it and leaves the selection unanchored', () => {
  const patch = click(notes, at(3), 3, {});

  assert.deepEqual(patch.ids, []);
  assert.equal(patch.anchorId, null);
});

test('the primary modifier toggles one row and anchors it either way', () => {
  assert.deepEqual(click(notes, at(1), 3, { metaKey: true }).ids, [1, 3]);
  assert.equal(click(notes, at(1), 3, { metaKey: true }).anchorId, 3);

  const removed = click(notes, at(1, 3), 3, { metaKey: true });
  assert.deepEqual(removed.ids, [1]);
  assert.equal(removed.anchorId, 3);
});

test('shift selects the range from the anchor toward the target in both directions', () => {
  assert.deepEqual(click(notes, at(2), 4, { shiftKey: true }).ids, [2, 3, 4]);
  assert.deepEqual(click(notes, at(4), 2, { shiftKey: true }).ids, [4, 3, 2]);
  assert.equal(click(notes, at(4), 2, { shiftKey: true }).anchorId, 4);
});

test('shift from an unanchored selection selects the clicked row alone', () => {
  const patch = click(notes, { ids: [], anchorId: null }, 2, { shiftKey: true });

  assert.deepEqual(patch.ids, [2]);
  assert.equal(patch.anchorId, 2);
});

test('shift with the primary modifier adds the range to what is already selected', () => {
  const patch = click(notes, at(1), 3, { metaKey: true, shiftKey: true });

  assert.deepEqual(patch.ids, [1, 2, 3]);
  assert.equal(patch.anchorId, 1);
});

test('the arrows step one row from the row the key came from, clamped to the list', () => {
  const step = (selection, focusedId, key, extend) =>
    idsOf(move(notes, selection, { focusedId, key, extend, entryIndex: () => 0 }));

  assert.deepEqual(step(at(2), 2, 'ArrowDown', false), [3]);
  assert.deepEqual(step(at(2), 2, 'ArrowUp', false), [1]);
  assert.deepEqual(step(at(1), 1, 'ArrowUp', false), [1]);
  assert.deepEqual(step(at(5), 5, 'ArrowDown', false), [5]);
});

test('the arrows enter an unselected list at the row it was last at', () => {
  let asked = 0;
  const patch = move(notes, none(), { focusedId: null, key: 'ArrowDown', extend: false, entryIndex: () => {
    asked++;
    return 3;
  } });

  assert.equal(asked, 1);
  assert.deepEqual(patch.ids, [4]);
  assert.equal(patch.focusId, 4);
});

test('a step with a selection never asks the viewport for an entry row', () => {
  let asked = 0;
  move(notes, at(2), { focusedId: 2, key: 'ArrowDown', extend: false, entryIndex: () => {
    asked++;
    return 0;
  } });

  assert.equal(asked, 0);
});

test('the arrows report no landing for an empty list', () => {
  assert.equal(move([], none(), { focusedId: null, key: 'ArrowDown', entryIndex: () => -1 }), null);
  assert.equal(move(notes, none(), { focusedId: null, key: 'ArrowDown', entryIndex: () => -1 }), null);
});

test('an extending arrow grows the range from the anchor it already had', () => {
  const patch = move(notes, { ids: [2, 3], anchorId: 2 },
    { focusedId: 3, key: 'ArrowDown', extend: true, entryIndex: () => 0 });

  assert.deepEqual(patch.ids, [2, 3, 4]);
  assert.equal(patch.anchorId, 2);
});

test('an extending arrow falls back to the focused row when the selection lost its anchor', () => {
  const patch = move(notes, { ids: [2, 3], anchorId: null },
    { focusedId: 3, key: 'ArrowUp', extend: true, entryIndex: () => 0 });

  assert.deepEqual(patch.ids, [3, 2]);
  assert.equal(patch.anchorId, 3);
});

// The browser hands the resolver the server's whole ordered result: a page it has not fetched yet is on that
// list as a bare id, which is all a range ever measures against. So an extension crosses those pages as if
// they were loaded, and the only anchor that can make a range unmeasurable is one the result has lost.
const loadedPage = [1, 2, 3, 4, 5].map(id => ({ id, fields: [{ name: 'Term', value: `word ${id}` }] }));
const listed = [...loadedPage, ...[6, 7, 8, 9, 10].map(id => ({ id }))];

const stepIn = (selection, focusedId, key, extend = false, entryIndex = () => 0) =>
  move(listed, selection, { focusedId, key, extend, entryIndex });

test('an extending arrow measures its range across a page that was never loaded', () => {
  const patch = stepIn({ ids: [4, 5], anchorId: 4 }, 5, 'ArrowDown', true);

  assert.deepEqual(patch.ids, [4, 5, 6]);
  assert.equal(patch.anchorId, 4);
  assert.equal(patch.focusId, 6);
});

test('an extending arrow keeps walking into the unloaded page from the anchor it started at', () => {
  const once = stepIn({ ids: [4, 5], anchorId: 4 }, 5, 'ArrowDown', true);
  const twice = stepIn(once, once.focusId, 'ArrowDown', true);

  assert.deepEqual(twice.ids, [4, 5, 6, 7]);
  assert.equal(twice.anchorId, 4);
});

test('an extending arrow at the last row of an unloaded page keeps the range it had', () => {
  const patch = stepIn({ ids: [8, 9, 10], anchorId: 8 }, 10, 'ArrowDown', true);

  assert.deepEqual(patch.ids, [8, 9, 10]);
  assert.equal(patch.focusId, 10);
});

test('an extending arrow from an anchor on an unloaded page measures from that row', () => {
  const up = stepIn({ ids: [6, 7], anchorId: 6 }, 6, 'ArrowUp', true);
  const down = stepIn({ ids: [7], anchorId: 7 }, 7, 'ArrowDown', true);

  assert.deepEqual(up.ids, [6, 5]);
  assert.deepEqual(down.ids, [7, 8]);
  assert.equal(down.anchorId, 7);
});

test('a step whose focused row is on an unloaded page steps from that row alone', () => {
  let asked = 0;
  const patch = stepIn({ ids: [8], anchorId: 8 }, 8, 'ArrowDown', false, () => {
    asked++;
    return 0;
  });

  assert.equal(asked, 0);
  assert.deepEqual(patch.ids, [9]);
  assert.equal(patch.focusId, 9);
});

test('an extending arrow with nothing selected takes only the row it entered at', () => {
  const patch = stepIn(none(), null, 'ArrowDown', true, () => 5);

  assert.deepEqual(patch.ids, [6]);
  assert.equal(patch.anchorId, 6);
});

// A range needs an anchor the list still holds: one it has lost is never measured from, so the step re-anchors
// on the row it moved to instead of reporting a range that would drop rows the user never let go of.
test('an extending arrow whose anchor left the result keeps only the row it moved to', () => {
  const down = stepIn({ ids: [4, 5, 6], anchorId: 99 }, 5, 'ArrowDown', true);
  const up = stepIn({ ids: [4, 5, 6], anchorId: 99 }, 5, 'ArrowUp', true);

  assert.deepEqual(down, { ids: [6], anchorId: 6, focusId: 6 });
  assert.deepEqual(up, { ids: [4], anchorId: 4, focusId: 4 });
});

test('a step from a row the result no longer holds is clamped to the top of the list', () => {
  assert.deepEqual(stepIn({ ids: [4, 5], anchorId: 4 }, 99, 'ArrowDown').ids, [1]);
  assert.deepEqual(stepIn({ ids: [4, 5], anchorId: 4 }, 99, 'ArrowUp').ids, [1]);
});

test('the range an extension measures is the list order, never the id numbers', () => {
  const gapped = [{ id: 2 }, { id: 3 }, { id: 9 }];
  const patch = move(gapped, { ids: [2, 3], anchorId: 3 },
    { focusedId: 3, key: 'ArrowDown', extend: true, entryIndex: () => 0 });

  assert.deepEqual(patch.ids, [3, 9]);
});

test('select-all takes the whole result and only moves the anchor when there was none', () => {
  assert.deepEqual(all(notes, none()).ids, [1, 2, 3, 4, 5]);
  assert.equal(all(notes, none(), 3).anchorId, 3);
  assert.equal(all(notes, { ids: [2], anchorId: 2 }, 3).anchorId, 2);
});

test('a freshly loaded list keeps only the rows it still holds, and drops the anchor', () => {
  const patch = containedIn([{ id: 2 }, { id: 3 }], { ids: [1, 3], anchorId: 1 });

  assert.deepEqual(patch.ids, [3]);
  assert.equal(patch.anchorId, null);
});

test('a landing with no editor moves the selection and reveals the row', () => {
  const patch = landing(notes, none(), 2, { open: false, id: null });

  assert.equal(patch.changed, true);
  assert.deepEqual(patch.ids, [3]);
  assert.equal(patch.anchorId, 3);
  assert.equal(patch.focusId, 3);
  assert.equal(patch.editorId, null);
});

test('a landing on the note the list is already on changes nothing', () => {
  assert.deepEqual(landing(notes, at(3), 2, { open: false, id: null }), {
    changed: false, ids: [3], anchorId: 3, focusId: null, editorId: null,
  });
});

test('a landing with the editor open moves the editor and never focuses a row', () => {
  const patch = landing(notes, at(3), 4, { open: true, id: 3 });

  assert.equal(patch.changed, true);
  assert.deepEqual(patch.ids, [5]);
  assert.equal(patch.editorId, 5);
  assert.equal(patch.focusId, null);
});

// The caret in a field being typed lives in the editor, so arriving at the note it already shows must not
// re-render it — the one case where a landing is deliberately a no-op.
test('a landing on the note already being edited keeps the caret where it is', () => {
  assert.deepEqual(landing(notes, at(3), 2, { open: true, id: 3 }), {
    changed: false, ids: [3], anchorId: 3, focusId: null, editorId: null,
  });
});

test('a landing while a draft is open still moves to the note the card aimed at', () => {
  const patch = landing(notes, none(), 0, { open: true, id: null });

  assert.equal(patch.changed, true);
  assert.equal(patch.editorId, 1);
});

test('a landing past either end of the list is not a change', () => {
  assert.equal(landing(notes, at(1), -1, { open: false, id: null }).changed, false);
  assert.equal(landing(notes, at(1), notes.length, { open: false, id: null }).changed, false);
});

test('a selection on its own is anchored to the note it holds', () => {
  assert.deepEqual(single(7), { ids: [7], anchorId: 7, focusId: null });
  assert.deepEqual(none(), { ids: [], anchorId: null, focusId: null });
  assert.deepEqual(none(4).focusId, 4);
});
