const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

// Anki's Rust backend logs to stdout, so the bridge prefixes its JSON with this marker
// and the last marked line wins.
const RESULT_PREFIX = '__ANKI_BRIDGE_RESULT__';
// A sync blocks the bridge for its whole duration, so the bridge reports what Anki is doing from a
// watcher thread on its own marker. These lines are only consumed when the caller asked for progress.
const PROGRESS_PREFIX = '__ANKI_BRIDGE_PROGRESS__';
const LOG_TAIL_LENGTH = 4000;
const FULL_SYNC_DIRECTIONS = ['upload', 'download'];
// Anki's own vocabulary for "what would a sync do", shared by the status check and a real sync.
const SYNC_REQUIREMENTS = ['NO_CHANGES', 'NORMAL_SYNC', 'FULL_SYNC'];
// The kinds of work a sync can be in. Anki reports one at a time, and the stage inside `normal_sync`
// is a string produced by Anki's Rust side, so it is passed through rather than matched against a list.
const PROGRESS_KINDS = ['normal_sync', 'full_sync', 'media_sync'];

const collectionBusy = () => Object.assign(new Error('The collection is busy. Try again when the current task ends.'), {
  statusCode: 409, code: 'collection_busy',
});

const tail = value => {
  const text = value.trim();
  return text.length > LOG_TAIL_LENGTH ? `…${text.slice(-LOG_TAIL_LENGTH)}` : text;
};

// A failed call leaves its reason in raw stdout/stderr instead of the marked result line,
// so record both to keep the server error log diagnosable.
function logBridgeFailure ({ message, code, stdout, stderr }) {
  process.stderr.write(`[anki-bridge] ${message} (exit code ${code})\n`
    + `[anki-bridge] stdout: ${tail(stdout)}\n[anki-bridge] stderr: ${tail(stderr)}\n`);
}

function parseBridgeOutput (stdout) {
  const line = stdout.split('\n').reverse().find(item => item.startsWith(RESULT_PREFIX));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length));
  } catch {
    return null;
  }
}

// One progress line as the UI sees it: a stable `kind`, plus only the fields that kind carries. Anki
// names the normal-sync stage and formats its own counts, so both stay strings ("Added/modified: 2↑ 1↓");
// only a full sync reports bytes, because a merge sends change chunks and has no size to report.
function parseProgressLine (line) {
  let payload;
  try { payload = JSON.parse(line.slice(PROGRESS_PREFIX.length)); } catch { return null; }
  if (!payload || !PROGRESS_KINDS.includes(payload.kind)) return null;
  if (payload.kind === 'normal_sync') {
    return { kind: 'normal_sync', stage: payload.stage || null,
      added: payload.added || null, removed: payload.removed || null };
  }
  if (payload.kind === 'full_sync') {
    const transferred = Number(payload.transferred);
    const total = Number(payload.total);
    if (!Number.isFinite(transferred) || !Number.isFinite(total)) return null;
    return { kind: 'full_sync', transferred, total };
  }
  if (!payload.media || typeof payload.media !== 'object') return null;
  return { kind: 'media_sync', media: {
    checked: payload.media.checked || null,
    added: payload.media.added || null,
    removed: payload.media.removed || null,
  } };
}

// The bundled helper carries the official Anki backend and needs no external Python or Anki Desktop;
// the fallback runs the checked-in bridge script with whatever Python the environment provides.
const bridgeProcess = ({ helperPath, pythonPath, bridgePath, collectionPath }) => helperPath
  ? { command: helperPath, args: [collectionPath] }
  : { command: pythonPath, args: [bridgePath, collectionPath] };

const runtimeMissing = message => Object.assign(new Error(message), { statusCode: 503 });

// A request waiting on a silent bridge has no other way out, so the deadline is what answers it. 504 says
// the bridge failed to answer in time, which is a different failure from a runtime that is not installed.
const bridgeTimeout = timeoutMs => Object.assign(
  new Error(`Anki bridge timed out after ${timeoutMs}ms`), { statusCode: 504 });

// Returns the reason the Anki runtime cannot run, or null when it is usable. Checked on every call so
// installing the runtime does not require a server restart, and so a missing runtime reports a setup
// problem instead of a spawn failure.
function ankiRuntimeProblem ({ helperPath, bundledHelperPath, pythonPath, bridgePath }) {
  if (helperPath) {
    return fs.existsSync(helperPath) ? null
      : `Bundled Anki runtime is missing at ${helperPath}. Reinstall Caro Anki.`;
  }
  if (pythonPath.includes('/') && !fs.existsSync(pythonPath)) {
    return `Anki runtime is missing. Build it with "npm run anki:runtime" (${bundledHelperPath})`
      + ' or install the "anki" package for the python3 on your PATH.';
  }
  return fs.existsSync(bridgePath) ? null : `Anki bridge script is missing at ${bridgePath}`;
}

function assertRuntime (config) {
  const problem = ankiRuntimeProblem(config);
  if (problem) throw runtimeMissing(problem);
}

// Anki stamps the collection at every write and remembers the stamp of its last successful sync in `ls`,
// which is the local half of Anki's own sync check (`Collection.sync_status_offline`). `NO_CHANGES` means
// "nothing to upload": a clean local collection can still be behind AnkiWeb, and only the server knows.
function syncRequired ({ mod, scm, lastSync }) {
  // A collection that has never synced has no stamp to compare against, and its schema stamp is set at
  // creation, so reporting a full sync there would stick forever on a fresh collection. Local content is
  // the one knowable reason to ask for a sync.
  if (!lastSync) return mod > 0 ? 'NORMAL_SYNC' : 'NO_CHANGES';
  if (scm > lastSync) return 'FULL_SYNC';
  return mod > lastSync ? 'NORMAL_SYNC' : 'NO_CHANGES';
}

// Anki answers NO_CHANGES both when there was nothing to do and after a merge it has just performed, so the
// answer alone cannot say whether data moved. Finalizing a sync always writes the collection's last-sync
// stamp (Anki's `finalize_sync` sets `ls`), so the stamps the bridge took around the call are the local
// evidence that a merge ran — which is the difference between "just uploaded a note" and "up to date".
function syncPerformed ({ before, after } = {}) {
  return Boolean(before && after && after.lastSync !== before.lastSync);
}

function runBridge ({ helperPath, pythonPath, bridgePath, collectionPath, timeoutMs, request,
  logger = logBridgeFailure }) {
  return new Promise((resolve, reject) => {
    const { command, args } = bridgeProcess({ helperPath, pythonPath, bridgePath, collectionPath });
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = { stdout: '', stderr: '' };
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);

    child.stdout.setEncoding('utf8').on('data', chunk => { output.stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { output.stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timeout);
      logger({ message: `bridge spawn failed: ${error.message}`, code: null, stdout: '', stderr: '' });
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      const payload = parseBridgeOutput(output.stdout);
      if (payload && !payload.error) return resolve(payload.result);
      if (payload) {
        logger({ message: `bridge error: ${payload.error}`, code, stdout: output.stdout,
          stderr: output.stderr });
        return reject(new Error(`Anki: ${payload.error}`));
      }
      // A killed bridge reports no exit code, so the deadline is what has to name this failure.
      const failure = timedOut ? bridgeTimeout(timeoutMs) : new Error(output.stderr.trim() || (code === 0
        ? 'Invalid Anki bridge response'
        : `Anki bridge exited with code ${code}`));
      logger({ message: failure.message, code, stdout: output.stdout, stderr: output.stderr });
      return reject(failure);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// Opening the collection costs a few hundred milliseconds, so one long-lived child serves every call.
class PersistentBridge {
  constructor ({ helperPath, pythonPath, bridgePath, collectionPath, timeoutMs, logger }) {
    Object.assign(this, { helperPath, pythonPath, bridgePath, collectionPath, timeoutMs, logger });
    this.child = null;
    this.current = null;
    this.stderr = '';
  }

  start () {
    if (this.child) return;
    const { command, args } = bridgeProcess(this);
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.stderr = '';
    readline.createInterface({ input: child.stdout }).on('line', line => this.onLine(line));
    child.stderr.setEncoding('utf8').on('data', chunk => { this.stderr += chunk; });
    // A bridge that cannot be talked to has nothing to answer with, so it is dropped and the next call
    // starts a fresh one.
    child.on('error', error => { this.stop(); this.settle(error); });
    child.on('close', code => {
      if (this.child !== child) return;
      this.child = null;
      this.settle(new Error(this.stderr.trim() || `Anki bridge exited with code ${code}`));
    });
  }

  // The one place a request ends: its deadline stops and the request is dropped before the caller hears the
  // reason. A bridge that went quiet used to be killed with its promise left pending, which blocked the
  // request that was waiting and every call queued behind it.
  settle (error, result) {
    if (!this.current) return;
    const { resolve, reject, timeout } = this.current;
    clearTimeout(timeout);
    this.current = null;
    if (error) reject(error); else resolve(result);
  }

  // A bridge that ran out of time cannot serve the call that follows it, so it is killed rather than reused.
  stop () {
    const child = this.child;
    this.child = null;
    child?.kill('SIGKILL');
  }

  // Logged before the request is answered, so the reason a call gave up sits in the server log next to the
  // Anki output it was waiting on.
  expire () {
    const error = bridgeTimeout(this.timeoutMs);
    this.logger({ message: error.message, code: null, stdout: '', stderr: this.stderr });
    this.stop();
    this.settle(error);
  }

  onLine (line) {
    const current = this.current;
    if (line.startsWith(PROGRESS_PREFIX)) {
      const progress = parseProgressLine(line);
      // The watcher keeps running until the sync returns, so a late line can outlive the request that
      // asked for it; without a listener it is simply dropped.
      if (!progress || !current?.onProgress) return;
      // A report proves the bridge is still working, so the deadline measures silence rather than the length
      // of the work: a sync that stops reporting still expires.
      current.arm();
      current.onProgress(progress);
      return;
    }
    if (!line.startsWith(RESULT_PREFIX) || !current) return;
    let payload;
    try { payload = JSON.parse(line.slice(RESULT_PREFIX.length)); } catch { return; }
    this.settle(payload.error ? new Error(`Anki: ${payload.error}`) : null, payload.result);
  }

  invoke (request, onProgress) {
    this.start();
    return new Promise((resolve, reject) => {
      const current = { resolve, reject, onProgress, timeout: null };
      current.arm = () => {
        clearTimeout(current.timeout);
        current.timeout = setTimeout(() => this.expire(), this.timeoutMs);
      };
      this.current = current;
      current.arm();
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  // Ending the stream is how the child is told to stop, so a request still waiting on it is answered here
  // instead of being left pending forever.
  close () {
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise(resolve => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
      child.once('close', () => { clearTimeout(timeout); resolve(); });
      child.stdin.end();
      this.child = null;
      this.settle(new Error('Anki bridge closed before it answered'));
    });
  }
}

class AnkiLocal {
  constructor ({
    collectionPath, helperPath, bundledHelperPath, pythonPath, bridgePath, timeoutMs = 30000,
    runner, logger = logBridgeFailure,
  }) {
    Object.assign(this, {
      collectionPath, helperPath, bundledHelperPath, pythonPath, bridgePath, timeoutMs, runner, logger,
    });
    this.bridge = runner ? null
      : new PersistentBridge({ collectionPath, helperPath, pythonPath, bridgePath, timeoutMs, logger });
    this.pending = Promise.resolve();
    this.pendingCount = 0;
    this.exclusive = false;
  }

  invoke (action, params, onProgress) {
    if (this.exclusive) return Promise.reject(collectionBusy());
    const request = { action, params };
    const operation = () => {
      assertRuntime(this);
      return this.runner ? this.runner({
        helperPath: this.helperPath, pythonPath: this.pythonPath, bridgePath: this.bridgePath,
        collectionPath: this.collectionPath, timeoutMs: this.timeoutMs, logger: this.logger, request,
      }) : this.bridge.invoke(request, onProgress);
    };
    // One call at a time: the bridge answers a single request per line.
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => {});
    this.pendingCount += 1;
    return result.finally(() => { this.pendingCount -= 1; });
  }

  beginExclusive () {
    if (this.exclusive || this.pendingCount) throw collectionBusy();
    this.exclusive = true;
  }

  endExclusive () { this.exclusive = false; }

  async close () { await this.bridge?.close(); }

  setCollectionPath (collectionPath) {
    if (this.pendingCount) throw collectionBusy();
    this.collectionPath = collectionPath;
    this.bridge = this.runner ? null
      : new PersistentBridge({ collectionPath, helperPath: this.helperPath, pythonPath: this.pythonPath,
        bridgePath: this.bridgePath, timeoutMs: this.timeoutMs, logger: this.logger });
  }

  // Validates the credentials without touching the collection, so an account is stored only once
  // AnkiWeb has accepted it.
  authenticate ({ username, password, endpoint }) {
    return this.invoke('login', { username, password, endpoint: endpoint || null });
  }

  // Always rejects rather than throws, so a caller can treat every failure path the same way.
  // `onProgress` turns on the bridge's progress watcher: Anki itself reports no transfer size for a
  // normal (merge) sync, so only a full sync and media sync carry numbers. Its result also carries the
  // `stamps` taken around the sync, which is what `syncPerformed` reads.
  async syncCollection ({ username, password, endpoint, media = false, direction = null,
    onProgress = null } = {}) {
    if (direction && !FULL_SYNC_DIRECTIONS.includes(direction)) {
      throw Object.assign(new Error(`direction must be ${FULL_SYNC_DIRECTIONS.join(' or ')}`),
        { statusCode: 400 });
    }
    // `progress` appears in the request only when the caller asked for it, so a sync that reports
    // nothing keeps exactly the request shape it had before the watcher existed.
    const reporting = typeof onProgress === 'function';
    return this.invoke('sync', {
      username, password, endpoint: endpoint || null, syncMedia: media === true, fullSync: direction,
      ...(reporting ? { progress: true } : {}),
    }, reporting ? onProgress : null);
  }

  // The local half of Anki's check: the collection's own stamps, no network.
  syncStamps () {
    return this.invoke('syncStamps', {});
  }

  // The server half, which Anki performs itself (login, meta comparison, 300s cache inside the
  // backend). Only a signed-in, locally clean collection ever reaches it, and the credentials are the
  // account's own — never a `.env` fallback.
  async syncCheck ({ username, password, endpoint } = {}) {
    const result = await this.invoke('syncCheck', {
      username, password, endpoint: endpoint || null,
    });
    if (!SYNC_REQUIREMENTS.includes(result?.required)) {
      throw new Error(`Invalid Anki sync status: ${result?.required}`);
    }
    return result;
  }

  async addNotes (notes) {
    const ids = await this.invoke('addNotes', { notes });
    if (!Array.isArray(ids) || ids.length !== notes.length
      || ids.some(id => id !== null && (!Number.isSafeInteger(id) || id <= 0))) {
      throw new Error('Invalid Anki note IDs; check Anki before retrying');
    }
    return ids;
  }

  // Anki's own global undo stack, not scoped to notes: `undo`/`redo` name the next entry that
  // `col.undo()`/`col.redo()` would apply, or are absent when there is nothing to do.
  undoStatus () {
    return this.invoke('undoStatus', {});
  }

  undo () {
    return this.invoke('undo', {});
  }

  redo () {
    return this.invoke('redo', {});
  }
}

module.exports = {
  AnkiLocal, SYNC_REQUIREMENTS, ankiRuntimeProblem, assertRuntime, logBridgeFailure, parseBridgeOutput,
  parseProgressLine, runBridge, syncPerformed, syncRequired,
};
