const { Menu } = require('electron');

const runSettingsSmoke = async ({ assert, evaluate, fs, listReady, path, profileRoot, reloadedAfter, until }) => {
await until(async () => await evaluate("document.querySelector('#agentDisabledPanel')?.hidden === false"
  + " && document.querySelector('#messageInput')?.disabled === true"));
await evaluate("document.querySelector('#ankiSettingsOpen').click()");
await until(async () => await evaluate("document.querySelector('#ankiSettingsDialog').open"));
await until(async () => await evaluate(
  "document.querySelector('#ankiSettingsPanel').getAttribute('aria-busy') === 'false'"));
await evaluate("document.querySelector('#ankiMaintenanceTab').click()");
await until(async () => await evaluate("document.querySelector('#ankiMaintenancePanel').hidden === false"
  + " && document.querySelector('#ankiBackupInterval').value === '30'"));
const automaticBackups = await evaluate(`(() => ({
  daily: document.querySelector('#ankiBackupDaily').value,
  weekly: document.querySelector('#ankiBackupWeekly').value,
  monthly: document.querySelector('#ankiBackupMonthly').value,
}))()`);
assert.ok(Object.values(automaticBackups).every(value => Number.isInteger(Number(value)) && Number(value) >= 0));
await evaluate(`(() => {
  const daily = document.querySelector('#ankiBackupDaily');
  daily.value = String(Number(daily.value) + 1);
  daily.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await until(async () => await evaluate(
  "document.querySelector('#ankiMaintenanceStatus').textContent === 'Backup settings saved.'"));
await evaluate("document.querySelector('#ankiCheckDatabase').click()");
await until(async () => await evaluate("document.querySelector('#ankiMaintenanceStatus').textContent"
  + " === 'Database checked.' && document.querySelector('#ankiMaintenanceReport').textContent"
  + ".includes('Backup created before the check.')"));
await evaluate("document.querySelector('#ankiCheckMedia').click()");
await until(async () => await evaluate("document.querySelector('#ankiMaintenanceStatus').textContent"
  + " === 'Media checked: 0 missing, 0 unused.'"));
await evaluate("document.querySelector('#ankiCreateBackup').click()");
await until(async () => await evaluate(
  "['Backup created.', 'No collection changes since the latest backup.'].includes("
  + "document.querySelector('#ankiMaintenanceStatus').textContent)"));
console.log('PASS: Anki maintenance checks and automatic backup settings work');
await evaluate("document.querySelector('#agentSettingsTab').click()");
await until(async () => await evaluate(
  "document.querySelector('#agentSettingsPanel').getAttribute('aria-busy') === 'false'"));
await evaluate("document.querySelector('#agentMemoriesTab').click()");
await until(async () => await evaluate("document.querySelector('#librarySettingsPanel').hidden === false"
  + " && document.querySelector('#agentMemoriesTab').getAttribute('aria-selected') === 'true'"
  + " && document.querySelector('#librarySelect').getAttribute('aria-label') === 'Memories'"));
assert.equal(await evaluate("document.querySelector('#libraryDescriptionField').hidden"), true);
console.log('PASS: Agent settings opens the editable Memories library');
await evaluate("document.querySelector('#quickSettingsTab').click()");
await until(async () => await evaluate("document.querySelector('#quickSettingsPanel').hidden === false"
  + " && document.querySelector('#quickSettingsPanel').getAttribute('aria-busy') === 'false'"));
await evaluate("document.querySelector('#quickShortcutsTab').click()");
await until(async () => await evaluate("document.querySelector('#quickShortcutsPanel').hidden === false"));
const shortcutLayout = await evaluate(`(() => {
  const dialog = document.querySelector('#ankiSettingsDialog');
  const list = document.querySelector('#shortcutSettingsList');
  const rows = [...list.querySelectorAll('.shortcut-setting')];
  return {
    dialogWidth: Math.round(dialog.getBoundingClientRect().width),
    rowOverflow: rows.some(row => row.scrollWidth > row.clientWidth),
    bindingWidths: rows.map(row => Math.round(row.querySelector('.shortcut-binding').getBoundingClientRect().width)),
    columns: new Set(rows.map(row => Math.round(row.getBoundingClientRect().left))).size,
  };
})()`);
assert.ok(shortcutLayout.dialogWidth <= 800, `shortcut dialog is too wide: ${shortcutLayout.dialogWidth}`);
assert.equal(shortcutLayout.rowOverflow, false);
assert.ok(shortcutLayout.bindingWidths.every(width => width === 150),
  `shortcut binding widths are uneven: ${shortcutLayout.bindingWidths}`);
assert.equal(shortcutLayout.columns, 2, `shortcut settings use ${shortcutLayout.columns} columns`);
assert.equal(await evaluate("document.querySelectorAll('#shortcutSettingsList .shortcut-setting-group').length"), 0);
assert.equal(await evaluate("document.querySelector('#shortcutResetAll span')"), null);
await evaluate(`(() => {
  const filter = document.querySelector('#shortcutFilter');
  filter.value = 'quick search';
  filter.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await until(async () => await evaluate(
  "document.querySelectorAll('#shortcutSettingsList .shortcut-setting').length === 1"));
assert.equal(await evaluate("document.querySelector('#shortcutSettingsList').textContent.trim()"
  + ".includes('Toggle quick search')"), true);
await evaluate(`(() => {
  const filter = document.querySelector('#shortcutFilter');
  filter.value = '';
  filter.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await until(async () => await evaluate(
  "document.querySelectorAll('#shortcutSettingsList .shortcut-setting').length > 1"));
await evaluate(`(() => {
  const binding = document.querySelector('.shortcut-binding[data-shortcut-id="focus-query"]');
  binding.click();
  binding.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'K', code: 'KeyK', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
  }));
})()`);
await until(async () => await evaluate(`(() => {
  const stored = JSON.parse(localStorage.getItem('anki-ai-shortcuts-v1') || '{}');
  return stored['focus-query']?.key === 'k' && stored['focus-query']?.shift === true;
})()`));
assert.equal(await evaluate("document.querySelector('[data-shortcut-id=\"focus-query\"]').textContent"),
  '⌘ + Shift + K');
assert.equal(Menu.getApplicationMenu().getMenuItemById('cards-search').accelerator,
  'CommandOrControl+Shift+K');
await evaluate("document.querySelector('#ankiSettingsDialog [data-dialog-close]').click()");
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {
  key: 'k', code: 'KeyK', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
}))`);
assert.equal(await evaluate('document.activeElement.id'), 'ankiQuery');
const panelState = await evaluate(`(() => {
  const body = document.querySelector('.anki-browser-body');
  return { quick: body.classList.contains('is-quick-collapsed'), chat: body.classList.contains('is-chat-collapsed') };
})()`);
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {
  key: 'œ', code: 'KeyQ', metaKey: true, altKey: true, bubbles: true, cancelable: true,
}))`);
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {
  key: '©', code: 'KeyG', metaKey: true, altKey: true, bubbles: true, cancelable: true,
}))`);
const toggledPanelState = await evaluate(`(() => {
  const body = document.querySelector('.anki-browser-body');
  return { quick: body.classList.contains('is-quick-collapsed'), chat: body.classList.contains('is-chat-collapsed') };
})()`);
assert.notEqual(toggledPanelState.quick, panelState.quick);
assert.notEqual(toggledPanelState.chat, panelState.chat);
await evaluate("document.querySelector('#ankiSettingsOpen').click()");
await until(async () => await evaluate("document.querySelector('#quickSettingsPanel').hidden === true"));
await evaluate("document.querySelector('#quickSettingsTab').click()");
await until(async () => await evaluate("document.querySelector('#quickSettingsPanel').hidden === false"
  + " && document.querySelector('#quickSettingsPanel').getAttribute('aria-busy') === 'false'"));
await evaluate("document.querySelector('#quickShortcutsTab').click()");
await until(async () => await evaluate("document.querySelector('#quickShortcutsPanel').hidden === false"));
await evaluate("document.querySelector('.shortcut-reset[data-shortcut-id=\"focus-query\"]').click()");
await until(async () => await evaluate(
  "!JSON.parse(localStorage.getItem('anki-ai-shortcuts-v1') || '{}')['focus-query']"));
assert.equal(await evaluate("document.querySelector('[data-shortcut-id=\"focus-query\"]').textContent"), '⌘ + F');
assert.equal(Menu.getApplicationMenu().getMenuItemById('cards-search').accelerator, 'CommandOrControl+F');
await evaluate("document.querySelector('#ankiSettingsDialog [data-dialog-close]').click()");
console.log('PASS: customizable shortcuts persist, dispatch, and restore defaults');
// The disabled panel is visible in the markup, so waiting for it proves nothing: wait for the state
// `applyAgentAvailability()` leaves behind after it has read the agent settings. The chat's own markup
// arrives as an injected fragment, so this wait is written for a document that does not hold it yet.
await until(async () => await evaluate("document.querySelector('#agentDisabledPanel')?.hidden === false"
  + " && document.querySelector('#messageInput')?.disabled === true"));
assert.equal(await evaluate("document.querySelector('#agentChatWorkspace').hidden"), true);
assert.equal(await evaluate("document.querySelector('#chatStatus').textContent"), '');
assert.equal(await evaluate("document.querySelector('#composerTools').hidden"), true);
assert.equal(await evaluate("document.querySelector('#agentName').disabled"), true);
assert.equal(await evaluate("document.querySelector('#reasoningEffort').disabled"), true);
assert.equal(await evaluate("document.querySelector('#clearSessions').hidden"), true);
console.log('PASS: disabled Agent renders only its unavailable state');
await evaluate(`(() => {
  const list = document.querySelector('#messageList');
  list.innerHTML = '<div class="operation-save"><button class="operation-save-preview-button" type="button"'
    + ' data-preview-title="Preview Instruction long-rule.md">Preview</button>'
    + '<template class="operation-save-preview-template"><div class="operation-save-preview">'
    + '<span class="operation-save-preview-path">long-rule.md</span><pre>First rule.\\nSecond rule.</pre>'
    + '</div></template></div>';
  list.querySelector('.operation-save-preview-button').click();
})()`);
await until(async () => await evaluate(`(() => {
  const dialog = document.querySelector('#agentProposalPreviewDialog');
  return dialog.open
    && document.querySelector('#agentProposalPreviewTitle').textContent === 'Preview Instruction long-rule.md'
    && document.querySelector('#agentProposalPreviewContent pre').textContent === 'First rule.\\nSecond rule.';
})()`));
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {
  key: 'Escape', bubbles: true, cancelable: true,
}))`);
await until(async () => await evaluate("!document.querySelector('#agentProposalPreviewDialog').open"));
await until(async () => await evaluate("document.querySelector('#agentProposalPreviewContent').children.length === 0"));
assert.equal(await evaluate("document.querySelector('#agentProposalPreviewContent').children.length"), 0);
console.log('PASS: a proposed file\'s Preview opens a dialog and clears on Escape');
await evaluate(`fetch('/api/anki-settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ modelName: 'Basic', allowDuplicate: false }),
}).then(response => response.json()).then(payload => { if (!payload.ok) throw new Error(payload.error); })`);
await evaluate("document.querySelector('#ankiSettingsOpen').click()");
await until(async () => await evaluate("document.querySelector('#ankiSettingsDialog').open"));
await evaluate(`document.querySelector('#ankiSettingsDialog .settings-tabs').dispatchEvent(new KeyboardEvent(
  'keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))`);
await until(async () => await evaluate("document.querySelector('#quickSettingsPanel').hidden === false"
  + " && document.querySelector('#quickSettingsPanel').getAttribute('aria-busy') === 'false'"));
assert.equal(await evaluate("document.querySelector('#quickSettingsTab').getAttribute('aria-selected')"), 'true');
assert.equal(await evaluate("document.querySelector('#ankiSettingsPanel').hidden"), true);
await until(async () => await evaluate("document.querySelector('#ankiDefaultModel').value === 'Basic'"));
assert.equal(await evaluate("document.querySelector('#ankiDefaultModel').value"), 'Basic');
assert.equal(await evaluate("document.querySelector('#ankiAllowDuplicate').checked"), false);
await evaluate("document.querySelector('#ankiSettingsDialog [data-dialog-close]').click()");
console.log('PASS: Quick settings opens from Anki and keeps collection defaults');
// Every profile step waits on the one option the row is showing, so the state that explains a timeout is read
// from the row itself rather than from the profile folder alone.
const profileState = async () => await evaluate(`JSON.stringify({
  options: Array.from(document.querySelector('#ankiProfileSelect').options).map(option => option.textContent),
  selected: document.querySelector('#ankiProfileSelect').selectedOptions[0]?.textContent ?? null,
  status: document.querySelector('#ankiProfileStatus').textContent,
  help: document.querySelector('#ankiProfileHelp').textContent,
  busy: document.querySelector('#ankiSettingsPanel').getAttribute('aria-busy'),
  folders: ${JSON.stringify(fs.readdirSync(profileRoot))},
})`);
const profileSelectShows = async name => await until(
  async () => await evaluate(`document.querySelector('#ankiProfileSelect').selectedOptions[0]?.textContent`
    + `.includes(${JSON.stringify(name)}) === true`), profileState);
await evaluate("document.querySelector('#ankiSettingsOpen').click()");
await until(async () => await evaluate("document.querySelector('#ankiSettingsDialog').open"));
await profileSelectShows('User 1');
await until(async () => await evaluate(
  "document.querySelector('#ankiSettingsPanel').getAttribute('aria-busy') === 'false'"));
assert.equal(await evaluate("document.querySelector('#ankiProfileConfirm').disabled"), false);
await listReady();
const profileReloadStamp = await evaluate('performance.timeOrigin');
// A rename moves a folder, so the row asks for the key twice: the first Enter inside the name only arms the
// confirm button and writes nothing, and the second Enter is the write. This asserts that gesture rather than
// a click on the button, because the arming is what a stale bundle loses first.
const pressEnterInName = () => evaluate(`document.querySelector('#ankiProfileName').dispatchEvent(
  new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
await evaluate(`(() => {
  document.querySelector('#ankiProfileConfirm').click();
  document.querySelector('#ankiProfileName').value = 'Caro';
})()`);
await pressEnterInName();
assert.equal(await evaluate(
  "document.querySelector('#ankiProfileConfirm').classList.contains('button-confirm')"), true);
assert.equal(await evaluate("document.querySelector('#ankiProfileName').hidden"), false);
assert.equal(await evaluate('performance.timeOrigin'), profileReloadStamp);
await pressEnterInName();
await reloadedAfter(profileReloadStamp, '#ankiProfileStatus');
await listReady();
await evaluate("document.querySelector('#ankiSettingsOpen').click()");
await until(async () => await evaluate("document.querySelector('#ankiSettingsDialog').open"));
await profileSelectShows('Caro');
await until(async () => await evaluate(
  "document.querySelector('#ankiSettingsPanel').getAttribute('aria-busy') === 'false'"));
assert.equal(fs.existsSync(path.join(profileRoot, 'User 1')), false);
assert.equal(fs.existsSync(path.join(profileRoot, 'Caro', 'collection.anki2')), true);
console.log('PASS: collection profile rename moves the managed collection and reloads');
await evaluate(`(() => {
  const select = document.querySelector('#ankiProfileSelect');
  select.value = select.options[0].value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('#ankiNewProfileName').value = 'Reading';
  document.querySelector('#ankiProfileConfirm').click();
})()`);
await until(async () => await evaluate(`Array.from(document.querySelector('#ankiProfileSelect').options)
  .some(option => option.textContent.includes('Reading'))`), profileState);
await evaluate(`(() => {
  const select = document.querySelector('#ankiProfileSelect');
  select.value = Array.from(select.options).find(option => option.textContent.includes('Reading')).value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await until(async () => await evaluate("document.querySelector('#ankiProfileActivate').disabled === false"),
  profileState);
const switchReloadStamp = await evaluate('performance.timeOrigin');
await evaluate("document.querySelector('#ankiProfileActivate').click()");
await reloadedAfter(switchReloadStamp, '#ankiProfileStatus');
await listReady();
await evaluate("document.querySelector('#ankiSettingsOpen').click()");
await until(async () => await evaluate("document.querySelector('#ankiSettingsDialog').open"));
await profileSelectShows('Reading');
assert.equal(fs.existsSync(path.join(profileRoot, 'Reading', 'collection.anki2')), true);
console.log('PASS: collection profiles create independently and switch with a reload');
await evaluate("document.querySelector('#agentSettingsTab').click()");
await until(async () => await evaluate(
  "document.querySelector('#agentSettingsPanel').getAttribute('aria-busy') === 'false'"));
assert.equal(await evaluate("document.querySelector('#agentProfileSelect').hidden"), true);
assert.equal(await evaluate("document.querySelector('#agentProfileConfirm').getAttribute('aria-label')"),
  'Create configuration');
assert.equal(await evaluate("document.querySelector('#agentProfileFormTitle').textContent"), 'NEW CONFIGURATION');
assert.equal(await evaluate("document.querySelector('#agentProfileForm').hidden"), false);
assert.equal(await evaluate("document.querySelector('#agentProfileApiKey').required"), true);
assert.deepEqual(await evaluate(`(() => {
  const limit = document.querySelector('#agentProfileStepLimit');
  return { value: limit.value, min: limit.min, max: limit.max, help: limit.nextElementSibling.textContent.trim() };
})()`), { value: '12', min: '4', max: '50',
  help: 'Maximum AI thinking and tool rounds for one request, not a card count. Higher values may take longer '
    + 'and perform more writes. At the limit, the Agent reports completed work and waits for you to decide '
    + 'whether to continue.' });
assert.deepEqual(await evaluate(`(() => {
  const dialog = document.querySelector('#ankiSettingsDialog');
  const head = dialog.querySelector('.dialog-head');
  const content = dialog.querySelector('.dialog-content');
  const tabs = dialog.querySelector('.settings-tabs');
  const panels = dialog.querySelector('.settings-dialog-panels');
  const regions = [...document.querySelectorAll('dialog.dialog')];
  return {
    everyDialog: regions.length === 11 && regions.every(item => {
      const body = item.querySelector('.dialog-body');
      return body?.children[0]?.classList.contains('dialog-head')
        && body?.children[1]?.classList.contains('dialog-content')
        && body.children.length === 2;
    }),
    overflow: [getComputedStyle(dialog).overflowY, getComputedStyle(dialog.querySelector('.dialog-body')).overflowY,
      getComputedStyle(content).overflowY, getComputedStyle(panels).overflowY].join(':'),
    split: content.getBoundingClientRect().top >= head.getBoundingClientRect().bottom - 1
      && panels.getBoundingClientRect().top >= tabs.getBoundingClientRect().bottom - 1,
  };
})()`), { everyDialog: true, overflow: 'hidden:hidden:hidden:auto', split: true });
await evaluate("document.querySelector('#agentToggle').click()");
await until(async () => await evaluate(
  "document.querySelector('#agentSettingsStatus').classList.contains('is-warn')"));
assert.equal(await evaluate("document.querySelector('#agentToggle').getAttribute('aria-checked')"), 'false');
await evaluate(`(() => {
  const name = document.querySelector('#agentNewProfileName');
  name.value = 'Smoke Agent';
  name.focus();
  document.querySelector('#agentProfileModel').focus();
})()`);
assert.equal(await evaluate("document.querySelector('#agentNewProfileName').hidden"), false);
await evaluate(`(() => {
  document.querySelector('#agentProfileModel').value = 'deepseek-chat';
  document.querySelector('#agentProfileBaseUrl').value = 'https://api.deepseek.com';
  document.querySelector('#agentProfileStepLimit').value = '18';
  document.querySelector('#agentProfileApiKey').value = 'test-key';
  document.querySelector('#agentProfileConfirm').click();
})()`);
await until(async () => await evaluate(`(() => {
  const select = document.querySelector('#agentProfileSelect');
  return !select.hidden && [...select.options].some(option => option.value === select.value
    && option.textContent === 'Smoke Agent');
})()`));
assert.equal(await evaluate("document.querySelector('#agentProfileStepLimit').value"), '18');
await evaluate("document.querySelector('#agentProfileConfirm').click()");
await until(async () => await evaluate("document.querySelector('#agentProfileName').hidden === false"));
await evaluate(`(() => {
  document.querySelector('#agentProfileName').value = 'Renamed Smoke Agent';
  document.querySelector('#agentProfileConfirm').click();
})()`);
await until(async () => await evaluate(
  "document.querySelector('#agentProfileFormStatus').textContent === 'Renamed Smoke Agent to Renamed Smoke Agent.'"));
await evaluate("document.querySelector('#agentProfileDelete').click()");
await evaluate("document.querySelector('#agentProfileDelete').click()");
await until(async () => await evaluate("document.querySelector('#agentProfileSelect').hidden === true"
  + " && document.querySelector('#agentNewProfileName').hidden === false"));
console.log('PASS: Agent configurations stay open to create, then rename and delete from one row');
await evaluate("document.querySelector('#ankiSettingsDialog [data-dialog-close]').click()");
console.log('PASS: agent settings keeps the current configuration form expanded');
};

const runNarrowSettingsSmoke = async ({ assert, delay, evaluate, fs, path, root, rowFieldGaps, until, window }) => {
await delay(500);
await evaluate("document.querySelector('#ankiSettingsOpen').click()");
await until(async () => await evaluate("document.querySelector('#ankiSettingsDialog').open"));
await evaluate("document.querySelector('#quickSettingsTab').click()");
await until(async () => await evaluate("document.querySelector('#quickSettingsPanel').hidden === false"
  + " && document.querySelector('#quickSettingsPanel').getAttribute('aria-busy') === 'false'"));
fs.writeFileSync(path.join(root, 'tmp/desktop-smoke.png'), (await window.capturePage()).toPNG());
window.setSize(640, 800);
await delay(200);
assert.equal(await evaluate(`(() => {
  const rect = document.querySelector('#ankiSettingsDialog').getBoundingClientRect();
  return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
})()`), true);
// Clearing the picker is written the moment it changes: the panel has no save button, so the change handler is
// the only way a value reaches the settings, and an empty note type is the write the server refuses.
await evaluate(`(() => {
  const select = document.querySelector('#ankiDefaultModel');
  select.value = '';
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await until(async () => await evaluate(
  "document.querySelector('#quickSettingsStatus').classList.contains('is-error')"));
// The collection-profile row is the settings dialog's own, and it states a shorter height than a studio's.
await evaluate("document.querySelector('#ankiSettingsTab').click()");
await until(async () => await evaluate("document.querySelector('#ankiSettingsPanel').hidden === false"
  + " && document.querySelector('#ankiSettingsPanel').getAttribute('aria-busy') === 'false'"));
const settingsRowGaps = await rowFieldGaps();
assert.ok(settingsRowGaps.length >= 1 && settingsRowGaps.every(gap => gap === 0),
  `a field and its row button differ in height: ${settingsRowGaps}`);
console.log('PASS: Quick settings fits a narrow window and renders validation errors');
};

module.exports = { runNarrowSettingsSmoke, runSettingsSmoke };
