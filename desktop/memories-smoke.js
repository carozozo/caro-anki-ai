const { app, BrowserWindow, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'caro-memories-test-'));
const memories = path.join(temporary, 'memories');
app.setPath('userData', temporary);
Object.assign(process.env, {
  PORT: '18791', SQLITE_PATH: path.join(temporary, 'app.sqlite'),
  ANKI_PROFILE_ROOT: path.join(temporary, 'profiles'), CARO_APP_VARIANT: 'dev', DEEPSEEK_API_KEY: '',
  CARO_SKILLS_DIR: path.join(temporary, 'skills'),
  CARO_INSTRUCTIONS_DIR: path.join(temporary, 'instructions'), CARO_MEMORIES_DIR: memories,
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, attempts = 100) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error('Timed out waiting for Memories settings state');
};

dialog.showErrorBox = (_title, message) => { throw new Error(message); };
require('./main');

app.whenReady().then(async () => {
  try {
    await until(() => BrowserWindow.getAllWindows().length > 0);
    const window = BrowserWindow.getAllWindows()[0];
    await until(() => !window.webContents.isLoading() && window.webContents.getURL().startsWith('http:'));
    const evaluate = expression => window.webContents.executeJavaScript(expression);
    await until(async () => await evaluate(
      "document.querySelector('#ankiBrowserStatus').textContent.trim().length > 0"));
    await evaluate("document.querySelector('#ankiSettingsOpen').click()");
    await until(async () => await evaluate("document.querySelector('#ankiSettingsDialog').open"));
    await evaluate("document.querySelector('#agentSettingsTab').click()");
    await until(async () => await evaluate(
      "document.querySelector('#agentSettingsPanel').getAttribute('aria-busy') === 'false'"));
    await until(async () => await evaluate(
      "document.querySelector('#agentProfileLanguage').value === 'zh-TW'"));
    const languages = await evaluate(
      "[...document.querySelector('#agentProfileLanguage').options].map(option => option.value)");
    assert.equal(languages.includes('en'), true);
    assert.equal(languages.includes('ja'), true);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-sub-tabs=\"agent\"] [data-sub-section]')]"
      + ".map(tab => tab.dataset.subSection)"), ['configuration', 'instructions', 'skills', 'memories']);
    await evaluate("document.querySelector('#agentMemoriesTab').click()");
    await until(async () => await evaluate(
      "document.querySelector('#agentMemoriesTab').getAttribute('aria-selected') === 'true'"
      + " && document.querySelector('#librarySelect').getAttribute('aria-label') === 'Memories'"));
    await evaluate(`(() => {
      const select = document.querySelector('#librarySelect');
      select.value = [...select.options].find(option => option.textContent === '- New memory -').value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until(async () => await evaluate("document.querySelector('#libraryNewName').hidden === false"));
    await evaluate(`(() => {
      const name = document.querySelector('#libraryNewName');
      name.value = 'reply-style';
      document.querySelector('#libraryConfirm').click();
    })()`);
    await until(async () => await evaluate(
      "document.querySelector('#libraryEntryName').value === 'reply-style.md'"));
    await evaluate(`(() => {
      const content = document.querySelector('#libraryEditorContent');
      content.value = '使用繁體中文回答。';
      content.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until(async () => await evaluate("fetch('/api/memories').then(response => response.json())"
      + ".then(({ memories }) => memories.some(entry => entry.name === 'reply-style.md'"
      + " && entry.content === '使用繁體中文回答。'))"));
    assert.equal(fs.readFileSync(path.join(memories, 'reply-style.md'), 'utf8'), '使用繁體中文回答。\n');
    console.log('PASS: Agent language and editable Memories Settings are available');
  } catch (error) {
    process.exitCode = 1;
    console.error(error);
  } finally {
    app.quit();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
