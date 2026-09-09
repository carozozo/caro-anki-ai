const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHarness, until } = require('./smoke/harness');
const { runEditorShortcutSmoke, runEditorSmoke } = require('./smoke/editor');
const { runLifecycleSmoke } = require('./smoke/lifecycle');
const { runNarrowSettingsSmoke, runSettingsSmoke } = require('./smoke/settings');
const { runStudiosSmoke } = require('./smoke/studios');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'caro-desktop-test-'));
const profileRoot = path.join(temporary, 'profiles');

app.setPath('userData', temporary);
Object.assign(process.env, {
  PORT: '18789',
  SQLITE_PATH: path.join(temporary, 'chat.sqlite'),
  ANKI_PROFILE_ROOT: profileRoot,
  CARO_APP_VARIANT: 'dev',
  DEEPSEEK_API_KEY: '',
  CARO_SKILLS_DIR: path.join(temporary, 'skills'),
  CARO_INSTRUCTIONS_DIR: path.join(temporary, 'instructions'),
  CARO_MEMORIES_DIR: path.join(temporary, 'memories'),
});
dialog.showErrorBox = (_title, message) => { throw new Error(message); };
require('./main');

app.whenReady().then(async () => {
  await until(() => BrowserWindow.getAllWindows().length > 0);
  const window = BrowserWindow.getAllWindows()[0];
  const smoke = createHarness({ window, root, profileRoot });
  await smoke.until(() => !window.webContents.isLoading() && window.webContents.getURL().startsWith('http:'));
  await smoke.assertAppShell();
  await runEditorSmoke(smoke);
  await runSettingsSmoke(smoke);
  await runStudiosSmoke(smoke);
  await runEditorShortcutSmoke(smoke);
  await runLifecycleSmoke(smoke);
  await runNarrowSettingsSmoke(smoke);
  console.log('PASS: isolated desktop smoke test; closing app');
  window.close();
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
  app.quit();
});
