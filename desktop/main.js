const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
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
let menuAccelerators = {};
const selectedMenuState = {};
const selectedMenuIds = [
  'selected-search', 'selected-copy', 'selected-change-deck', 'selected-set-due', 'selected-send-agent',
  'selected-delete',
];
const menuShortcutIds = new Set([
  'account', 'sync', 'settings', 'focus-query', 'new', 'study-options', 'note-type', 'manage-decks',
  'manage-tags', 'preview', 'find-replace', 'search', 'copy', 'deck', 'due', 'ai', 'delete', 'focus-chat',
  'toggle-chat',
]);

const sendMenuCommand = command => {
  if (!window || window.isDestroyed()) return;
  window.webContents.send('caro-menu-command', command);
};

const commandItem = (id, label, command, shortcutId, options = {}) => ({
  id, label, ...(menuAccelerators[shortcutId] ? { accelerator: menuAccelerators[shortcutId] } : {}),
  click: () => sendMenuCommand(command), ...options,
});

const applicationMenu = () => {
  const isMac = process.platform === 'darwin';
  const appItems = [
    ...(isMac ? [{ role: 'about' }, { type: 'separator' }] : [{ role: 'about' }]),
    commandItem('anki-account', 'AnkiWeb Account', 'account', 'account'),
    commandItem('anki-sync', 'Sync with AnkiWeb', 'sync', 'sync'),
    commandItem('anki-settings', 'Settings…', 'settings', 'settings'),
    ...(isMac ? [
      { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' },
      { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] : [{ type: 'separator' }, { role: 'quit' }]),
  ];
  return Menu.buildFromTemplate([
    { label: appName, submenu: appItems },
    {
      label: 'Cards',
      submenu: [
        commandItem('cards-search', 'Search Cards', 'focus-query', 'focus-query'),
        commandItem('cards-new', 'New Note', 'new-note', 'new'),
        { type: 'separator' },
        commandItem('cards-study-options', 'Study Options', 'study-options', 'study-options'),
        commandItem('cards-note-type', 'Note Type Studio', 'note-type', 'note-type'),
        commandItem('cards-decks', 'Deck Studio', 'decks', 'manage-decks'),
        commandItem('cards-tags', 'Tags', 'tags', 'manage-tags'),
        commandItem('cards-preview', 'Preview Note', 'preview', 'preview'),
        commandItem('cards-find-replace', 'Find and Replace…', 'find-replace', 'find-replace'),
        { type: 'separator' },
        {
          label: 'Selected Notes',
          submenu: [
            commandItem('selected-search', 'Search Selected Notes', 'selected-search', 'search', { enabled: false }),
            commandItem('selected-copy', 'Copy Selected Notes', 'selected-copy', 'copy', { enabled: false }),
            commandItem('selected-change-deck', 'Change Deck…', 'selected-change-deck', 'deck', { enabled: false }),
            commandItem('selected-set-due', 'Set Due Time…', 'selected-set-due', 'due', { enabled: false }),
            commandItem('selected-send-agent', 'Send to Anki Agent', 'selected-send-agent', 'ai', { enabled: false }),
            { type: 'separator' },
            commandItem('selected-delete', 'Delete Selected Notes', 'selected-delete', 'delete', { enabled: false }),
          ],
        },
      ],
    },
    {
      label: 'Anki Agent',
      submenu: [
        commandItem('agent-focus-message', 'Focus Message', 'focus-chat', 'focus-chat'),
        commandItem('agent-toggle-panel', 'Show or Hide Anki Agent', 'toggle-chat', 'toggle-chat'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' },
        { role: 'paste' }, ...(isMac ? [{ role: 'pasteAndMatchStyle' }] : []), { role: 'delete' },
        { type: 'separator' }, { role: 'selectAll' },
        ...(isMac ? [{ type: 'separator' }, {
          label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
        }] : []),
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }, { type: 'separator' }, { role: 'window' }]
          : [{ role: 'close' }]),
      ],
    },
  ]);
};

const updateSelectedMenu = state => {
  Object.assign(selectedMenuState, state);
  const menu = Menu.getApplicationMenu();
  selectedMenuIds.forEach(id => {
    const item = menu?.getMenuItemById(id);
    if (item) item.enabled = selectedMenuState[id] === true;
  });
  const deleteItem = menu?.getMenuItemById('selected-delete');
  if (deleteItem && typeof selectedMenuState['selected-delete-armed'] === 'boolean') {
    deleteItem.label = selectedMenuState['selected-delete-armed']
      ? 'Delete Selected Notes (Choose Again)' : 'Delete Selected Notes';
  }
};

const rebuildApplicationMenu = () => {
  Menu.setApplicationMenu(applicationMenu());
  updateSelectedMenu({});
};

ipcMain.on('caro-menu-state', (event, state) => {
  if (event.sender !== window?.webContents || !state || typeof state !== 'object') return;
  updateSelectedMenu(state);
});

ipcMain.on('caro-menu-shortcuts', (event, accelerators) => {
  if (event.sender !== window?.webContents || !accelerators || typeof accelerators !== 'object') return;
  menuAccelerators = Object.fromEntries(Object.entries(accelerators).filter(([id, accelerator]) =>
    menuShortcutIds.has(id) && typeof accelerator === 'string' && accelerator));
  rebuildApplicationMenu();
});

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
        // A development build may have started with the installed helper because the checkout runtime did
        // not exist yet. Switch the restarted backend to the rebuilt checkout helper, not the stale bundle.
        if (config.app.variant === 'dev') process.env.ANKI_HELPER_PATH = developmentHelper;
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
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  rebuildApplicationMenu();
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
