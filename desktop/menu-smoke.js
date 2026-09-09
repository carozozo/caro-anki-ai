const { app, BrowserWindow, dialog, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'caro-menu-test-'));
app.setPath('userData', temporary);
Object.assign(process.env, {
  PORT: '18790', SQLITE_PATH: path.join(temporary, 'chat.sqlite'),
  ANKI_PROFILE_ROOT: path.join(temporary, 'profiles'),
  CARO_APP_VARIANT: 'dev', DEEPSEEK_API_KEY: '',
  CARO_SKILLS_DIR: path.join(temporary, 'skills'),
  CARO_INSTRUCTIONS_DIR: path.join(temporary, 'instructions'),
  CARO_MEMORIES_DIR: path.join(temporary, 'memories'),
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, attempts = 100) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error('Timed out waiting for native menu state');
};
const menuItem = id => Menu.getApplicationMenu().getMenuItemById(id);
const selectedMenuIds = [
  'selected-search', 'selected-copy', 'selected-change-deck', 'selected-set-due', 'selected-send-agent',
  'selected-delete',
];

dialog.showErrorBox = (_title, message) => { throw new Error(message); };
require('./main');

app.whenReady().then(async () => {
  try {
    await until(() => BrowserWindow.getAllWindows().length > 0);
    const window = BrowserWindow.getAllWindows()[0];
    await until(() => !window.webContents.isLoading() && window.webContents.getURL().startsWith('http:'));
    const evaluate = expression => window.webContents.executeJavaScript(expression);
    await until(async () => await evaluate(`Boolean(window.CaroDesktop)
      && document.querySelector('#ankiBrowserStatus').textContent.trim().length > 0`));

    const menu = Menu.getApplicationMenu();
    assert.deepEqual(menu.items.slice(0, 6).map(item => item.label),
      ['Caro Anki Dev', 'Cards', 'Anki Agent', 'Edit', 'View', 'Window']);
    assert.equal(menuItem('anki-sync').accelerator, 'CommandOrControl+Shift+Y');
    assert.equal(menuItem('cards-search').accelerator, 'CommandOrControl+F');
    assert.equal(menuItem('cards-new').accelerator, 'CommandOrControl+N');
    assert.equal(menuItem('cards-study-options').accelerator, 'CommandOrControl+Shift+O');
    assert.equal(menuItem('cards-find-replace').accelerator, 'CommandOrControl+Shift+R');
    assert.equal(menuItem('selected-delete').accelerator, 'CommandOrControl+Backspace');
    assert.equal(menuItem('agent-toggle-panel').accelerator, 'CommandOrControl+Alt+G');
    const viewRoles = menu.items.find(item => item.label === 'View').submenu.items.map(item => item.role);
    assert.deepEqual(viewRoles, ['reload', 'forcereload', 'toggledevtools', null, 'resetzoom', 'zoomin', 'zoomout',
      null, 'togglefullscreen']);
    const windowRoles = menu.items.find(item => item.label === 'Window').submenu.items.map(item => item.role);
    assert.deepEqual(windowRoles, process.platform === 'darwin'
      ? ['minimize', 'zoom', null, 'front', null, 'window'] : ['minimize', 'zoom', 'close']);
    assert.ok(selectedMenuIds.every(id => menuItem(id).enabled === false));

    menuItem('cards-find-replace').click();
    await until(async () => await evaluate("document.querySelector('#ankiFindReplaceDialog').open"));
    assert.equal(await evaluate("document.querySelector('#ankiFindReplaceSelected').disabled"), true);
    await evaluate(`localStorage.setItem('anki-ai-find-replace-history', JSON.stringify({
      find: ['Find history'], replace: ['Replace history'],
    }));
    document.querySelector('#ankiFindReplaceFind').value = 'stale find';
    document.querySelector('#ankiFindReplaceWith').value = 'stale replacement';`);
    await evaluate("document.querySelector('#ankiFindReplaceDialog [data-dialog-close]').click()");
    menuItem('cards-find-replace').click();
    await until(async () => await evaluate("document.querySelector('#ankiFindReplaceDialog').open"));
    assert.deepEqual(await evaluate(`[
      document.querySelector('#ankiFindReplaceFind').value,
      document.querySelector('#ankiFindReplaceWith').value,
      document.querySelector('#ankiFindReplaceFindHistory').options[0]?.value,
      document.querySelector('#ankiFindReplaceWithHistory').options[0]?.value,
    ]`), ['', '', 'Find history', 'Replace history']);
    await evaluate("document.querySelector('#ankiFindReplaceDialog [data-dialog-close]').click()");

    menuItem('anki-settings').click();
    await until(async () => await evaluate("document.querySelector('#ankiSettingsDialog').open"));
    await evaluate("document.querySelector('#ankiSettingsDialog [data-dialog-close]').click()");

    await evaluate(`fetch('/api/anki/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelName: 'Basic', deckName: 'Default', tags: [],
        fields: { Front: 'Native menu smoke', Back: 'Selection state' },
      }),
    }).then(response => response.json()).then(payload => {
      if (!payload.ok) throw new Error(payload.error);
      const input = document.querySelector('#ankiQuery');
      input.value = 'Native menu smoke';
      document.querySelector('#ankiSearchForm').dispatchEvent(new Event('submit', {
        bubbles: true, cancelable: true,
      }));
    })`);
    await until(async () => await evaluate("Boolean(document.querySelector('#ankiNoteList .anki-note-row'))"));
    await evaluate("document.querySelector('#ankiNoteList .anki-note-row').click()");
    await until(() => selectedMenuIds.every(id => menuItem(id).enabled === true));

    menuItem('cards-find-replace').click();
    await until(async () => await evaluate("document.querySelector('#ankiFindReplaceDialog').open"));
    assert.equal(await evaluate("document.querySelector('#ankiFindReplaceSelected').checked"), true);
    assert.equal(await evaluate("document.querySelector('#ankiFindReplaceSelected').disabled"), false);
    await evaluate("document.querySelector('#ankiFindReplaceDialog [data-dialog-close]').click()");

    menuItem('selected-change-deck').click();
    await until(async () => await evaluate("document.querySelector('#ankiBatchDialog').open"));
    await evaluate("document.querySelector('#ankiBatchDialog [data-dialog-close]').click()");
    menuItem('selected-delete').click();
    await until(async () => await evaluate("document.querySelector('#ankiSelectedDelete').classList.contains('button-danger')"));
    assert.equal(menuItem('selected-delete').label, 'Delete Selected Notes (Choose Again)');
    menuItem('selected-delete').click();
    await until(() => selectedMenuIds.every(id => menuItem(id).enabled === false));
    console.log('PASS: native Caro Anki menu routes commands and tracks selected notes');
  } catch (error) {
    process.exitCode = 1;
    console.error(error);
  } finally {
    app.quit();
  }
});
