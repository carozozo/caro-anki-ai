// Reports progress on a slow cadence and answers only after the last report, so a transport that measures
// its deadline against the total duration of a call kills a sync that is still working. One report every
// 100ms, 15 in all, then the answer — longer than the deadline a test gives it.
const readline = require('node:readline');

const RESULT_PREFIX = '__ANKI_BRIDGE_RESULT__';
const PROGRESS_PREFIX = '__ANKI_BRIDGE_PROGRESS__';
const CADENCE_MS = 100;
const REPORTS = 15;

const input = readline.createInterface({ input: process.stdin });
input.on('line', () => {
  let sent = 0;
  const reporter = setInterval(() => {
    sent += 1;
    process.stdout.write(`${PROGRESS_PREFIX}${JSON.stringify({
      kind: 'normal_sync', stage: `Step ${sent}`, added: null, removed: null,
    })}\n`);
    if (sent < REPORTS) return;
    clearInterval(reporter);
    process.stdout.write(
      `${RESULT_PREFIX}${JSON.stringify({ result: { required: 'NO_CHANGES' }, error: null })}\n`,
    );
  }, CADENCE_MS);
});
input.on('close', () => process.exit(0));
