const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { watch, openSync, closeSync, mkdirSync, existsSync } = require('node:fs');
const path = require('node:path');
const { loadConfig, projectRoot } = require('../backend/config');

// The bundled Anki runtime is the reason Caro Anki needs no Anki Desktop and no system Python. A
// checkout without one falls back to the build output under tmp/, resolved by backend/config.js.
const packagedHelper = path.join(process.resourcesPath, 'anki-runtime', 'anki-helper', 'anki-helper');
const developmentHelper = path.join(projectRoot, 'tmp', 'anki-runtime', 'anki-helper', 'anki-helper');
const hasRuntimeOverride = process.env.ANKI_HELPER_PATH || process.env.ANKI_BRIDGE_PATH;
if (!hasRuntimeOverride) {
  const helper = process.env.CARO_APP_VARIANT === 'dev' && existsSync(developmentHelper)
    ? developmentHelper : packagedHelper;
  if (existsSync(helper)) process.env.ANKI_HELPER_PATH = helper;
}
const config = loadConfig();
const appName = config.app.title;
app.setName(appName);
const node = process.env.CARO_NODE_PATH || process.env.npm_node_execpath || '/opt/homebrew/bin/node';
const origin = `http://127.0.0.1:${config.port}`;
let window, child, timer, restoring = false, quitting = false;
let backendDirty = false, frontendDirty = false, runtimeDirty = false, applying = false, cleanupDone = false;
const watchers = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const waitForServer = async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json()).service === 'caro-anki') return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Backend did not start. Check ${projectRoot}/tmp/desktop-dev.log`);
};

const reload = async () => {
  await waitForServer();
  if (!quitting && window && !window.isDestroyed()) await window.loadURL(origin);
};

const startBackend = () => {
  mkdirSync(path.join(projectRoot, 'tmp'), { recursive: true });
  const log = openSync(path.join(projectRoot, 'tmp/desktop-dev.log'), 'a');
  child = spawn(node, ['backend/server.js'], {
    cwd: projectRoot, stdio: ['ignore', log, log],
    env: { ...process.env, CARO_APP_VARIANT: config.app.variant, HOST: '127.0.0.1' },
  });
  closeSync(log);
  child.on('error', error => { child = null; fail(error); });
  child.once('exit', code => {
    child = null;
    if (quitting || restoring) return;
    if (code !== 0) return fail(new Error('Backend exited unexpectedly. See tmp/desktop-dev.log.'));
    startBackend();
    reload().catch(fail);
  });
};

const stopBackend = async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const current = child;
  const exited = new Promise(resolve => current.once('exit', resolve));
  current.kill('SIGTERM');
  await exited;
};

const restart = async () => {
  if (restoring || quitting) return;
  restoring = true;
  await stopBackend();
  restoring = false;
  if (quitting) return;
  startBackend();
  await reload();
};

const rebuildRuntime = () => new Promise((resolve, reject) => {
  const build = spawn('sh', [path.join(projectRoot, 'scripts/sh/build-anki-runtime.sh')], {
    cwd: projectRoot, stdio: 'inherit', env: process.env,
  });
  build.once('error', reject);
  build.once('exit', code => code === 0 ? resolve() : reject(new Error(`Anki runtime build exited with ${code}`)));
});

const applyChanges = async () => {
  if (applying || quitting) return;
  applying = true;
  try {
    while (!quitting && (backendDirty || frontendDirty || runtimeDirty)) {
      const needsRestart = backendDirty || runtimeDirty;
      const needsRuntimeBuild = runtimeDirty;
      backendDirty = frontendDirty = runtimeDirty = false;
      if (needsRuntimeBuild) {
        await stopBackend();
        await rebuildRuntime();
      }
      await (needsRestart ? restart() : reload());
    }
  } finally { applying = false; }
};

const fail = error => {
  dialog.showErrorBox(appName, error.message);
  app.quit();
};

const start = async () => {
  const probe = require('node:net').createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(config.port, '127.0.0.1', () => probe.close(resolve));
  });
  startBackend();
  await waitForServer();
  window = new BrowserWindow({
    width: 1400, height: 950, title: appName,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  await window.loadURL(origin);
  watchSources();
};

const watchSources = () => {
  for (const directory of ['frontend', 'backend', 'sqlite']) {
    watchers.push(watch(path.join(projectRoot, directory), { recursive: true }, (_event, filename) => {
      if (directory === 'sqlite' && !/\.(js|sql)$/.test(String(filename))) return;
      if (directory === 'frontend') frontendDirty = true;
      else {
        backendDirty = true;
        runtimeDirty ||= directory === 'backend' && path.basename(String(filename)) === 'anki_bridge.py';
      }
      clearTimeout(timer);
      timer = setTimeout(() => applyChanges().catch(fail), 350);
    }));
  }
};

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('activate', () => window?.show());
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (cleanupDone) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    clearTimeout(timer);
    watchers.forEach(watcher => watcher.close());
    stopBackend().then(() => {
      cleanupDone = true;
      app.quit();
    }).catch(fail);
  });
  app.whenReady().then(start).catch(fail);
}
