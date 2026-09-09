// A sync blocks the Anki bridge for its whole duration, so the UI cannot ask the bridge what is
// happening: the bridge pushes each state to `record`, and the progress route reads this snapshot.
// Keeping the state in one module is what lets the sync route write it and the progress route read it
// without either reaching into the other, and it keeps the poll cheap — reading a snapshot never calls
// the bridge, which matters because the bridge answers one request at a time and a sync holds it.
let current = null;

const empty = () => ({ running: false, direction: null, update: null, elapsedMs: 0 });

// The sync route owns the lifecycle: `begin` before the bridge call, `record` from the bridge's progress
// lines, `end` once that call settles — a failure included, so a stuck snapshot cannot leave the UI
// polling forever.
const begin = (direction = null) => {
  current = { running: true, direction, update: null, startedAt: Date.now(), elapsedMs: 0 };
};

// A line that arrives after the sync settled is a late report of work that already finished, so it is
// dropped rather than shown as the current state.
const record = update => {
  if (current?.running) current.update = update;
};

const end = () => {
  if (current?.running) current.elapsedMs = Date.now() - current.startedAt;
  if (current) current.running = false;
};

const snapshot = () => {
  if (!current) return empty();
  const { running, direction, update, startedAt, elapsedMs } = current;
  return { running, direction, update, elapsedMs: running ? Date.now() - startedAt : elapsedMs };
};

module.exports = { begin, end, record, snapshot };
