const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'caro-desktop-test-'));
const profileRoot = path.join(temporary, 'profiles');
app.setPath('userData', temporary);
Object.assign(process.env, {
  PORT: '18789', SQLITE_PATH: path.join(temporary, 'chat.sqlite'),
  ANKI_PROFILE_ROOT: profileRoot,
  CARO_APP_VARIANT: 'dev', DEEPSEEK_API_KEY: '',
  CARO_SKILLS_DIR: path.join(temporary, 'skills'),
  CARO_INSTRUCTIONS_DIR: path.join(temporary, 'instructions'),
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, describe = null, attempts = 100) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for desktop state${describe ? `: ${await describe()}` : ''}`);
};
const touch = relative => {
  const file = path.join(root, relative);
  const now = new Date();
  fs.utimesSync(file, now, now);
};
dialog.showErrorBox = (_title, message) => { throw new Error(message); };
require('./main');

app.whenReady().then(async () => {
  await until(() => BrowserWindow.getAllWindows().length > 0);
  const window = BrowserWindow.getAllWindows()[0];
  await until(() => !window.webContents.isLoading() && window.webContents.getURL().startsWith('http:'));
  // A script that throws inside the renderer answers with nothing but "Script failed to execute", so the script
  // itself is carried out with the failure: it is what says which assertion in this file stopped the run.
  const evaluate = expression => window.webContents.executeJavaScript(expression)
    .catch(error => { throw new Error(`${error.message}\n  script: ${expression.trim().slice(0, 600)}`); });
  // An action that succeeds reloads the page; one that fails leaves its sentence in a status element. Reporting
  // that sentence turns "the page never reloaded" into the reason it did not.
  const reloadedAfter = async (stamp, statusSelector) => {
    try {
      await until(async () => await evaluate('performance.timeOrigin') !== stamp);
    } catch {
      throw new Error(`The page did not reload. ${statusSelector}: `
        + await evaluate(`document.querySelector('${statusSelector}').textContent`));
    }
  };
  // A reload starts a fresh document, and the boot's first list read is what opens the collection, so every step
  // that follows a reload waits for the list it renders before driving the page again.
  const listReady = async () => until(async () => await evaluate(`(() => {
    const status = document.querySelector('#ankiBrowserStatus').textContent.trim();
    return Boolean(status) && !status.startsWith('Loading');
  })()`));
  // A row pairs a field with the icon button that acts on it, and the two are one control: the row states one
  // height and the field takes it, so this reports the difference for every visible row in the open dialog. The
  // height itself depends on the dialog (a studio's rows are taller than Settings' own), so only the pairing is
  // asserted. A row whose field is hidden (the note type list showing a name to rename instead) is not one.
  const rowFieldGaps = async () => await evaluate(`(() => {
    const rows = [...document.querySelectorAll(
      '.anki-picker-row, .anki-entity-section-head, .anki-inline-control')]
      .filter(row => row.offsetParent !== null);
    const height = element => Math.round(element.getBoundingClientRect().height);
    return rows.map(row => {
      const field = [...row.querySelectorAll('.field')].find(item => item.offsetParent !== null);
      const button = row.querySelector('.button-icon');
      return field && button ? height(field) - height(button) : null;
    }).filter(gap => gap !== null);
  })()`);
  assert.equal(await evaluate('typeof require'), 'undefined');
  assert.equal(await evaluate('document.title'), 'Caro Anki Dev');
  assert.ok(await evaluate('document.body.innerText.length > 0'));
  await until(async () => await evaluate("document.querySelector('#agentDisabledPanel')?.hidden === false"
    + " && document.querySelector('#messageInput')?.disabled === true"));
  await evaluate("document.querySelector('#ankiSettingsOpen').click()");
  await until(async () => await evaluate("document.querySelector('#ankiSettingsDialog').open"));
  await evaluate("document.querySelector('#shortcutsSettingsTab').click()");
  await until(async () => await evaluate("document.querySelector('#shortcutsSettingsPanel').hidden === false"
    + " && document.querySelector('#shortcutsSettingsPanel').getAttribute('aria-busy') === 'false'"));
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
  await until(async () => await evaluate("document.querySelectorAll('#shortcutSettingsList .shortcut-setting').length === 1"));
  assert.equal(await evaluate("document.querySelector('#shortcutSettingsList').textContent.trim()"
    + ".includes('Toggle quick search')"), true);
  await evaluate(`(() => {
    const filter = document.querySelector('#shortcutFilter');
    filter.value = '';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(async () => await evaluate("document.querySelectorAll('#shortcutSettingsList .shortcut-setting').length > 1"));
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
  await until(async () => await evaluate("document.querySelector('#shortcutsSettingsPanel').hidden === true"));
  await evaluate("document.querySelector('#shortcutsSettingsTab').click()");
  await until(async () => await evaluate("document.querySelector('#shortcutsSettingsPanel').hidden === false"));
  await evaluate("document.querySelector('.shortcut-reset[data-shortcut-id=\"focus-query\"]').click()");
  await until(async () => await evaluate(
    "!JSON.parse(localStorage.getItem('anki-ai-shortcuts-v1') || '{}')['focus-query']"));
  assert.equal(await evaluate("document.querySelector('[data-shortcut-id=\"focus-query\"]').textContent"), '⌘ + F');
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
    return dialog.open && document.querySelector('#agentProposalPreviewTitle').textContent === 'Preview Instruction long-rule.md'
      && document.querySelector('#agentProposalPreviewContent pre').textContent === 'First rule.\\nSecond rule.';
  })()`));
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }))`);
  await until(async () => await evaluate("!document.querySelector('#agentProposalPreviewDialog').open"));
  await until(async () => await evaluate("document.querySelector('#agentProposalPreviewContent').children.length === 0"));
  assert.equal(await evaluate("document.querySelector('#agentProposalPreviewContent').children.length"), 0);
  console.log('PASS: instruction and skill Preview opens a dialog and clears on Escape');
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
    document.querySelector('#agentProfileApiKey').value = 'test-key';
    document.querySelector('#agentProfileConfirm').click();
  })()`);
  await until(async () => await evaluate(`(() => {
    const select = document.querySelector('#agentProfileSelect');
    return !select.hidden && [...select.options].some(option => option.value === select.value
      && option.textContent === 'Smoke Agent');
  })()`));
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
  await until(async () => await evaluate(`(() => {
    const status = document.querySelector('#ankiBrowserStatus').textContent.trim();
    return status && !status.startsWith('Loading');
  })()`));
  const quickSearchLabels = () => evaluate(`Array.from(
    document.querySelectorAll('#ankiQuickSearchList .anki-quick-group'),
  ).map(group => group.dataset.group)`);
  await until(async () => (await quickSearchLabels()).length === 5);
  assert.deepEqual(await quickSearchLabels(), ['RECENT', 'CARD STATE', 'FLAGS', 'NOTE TYPES', 'DECKS']);
  await evaluate(`fetch('/api/anki/notes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modelName: 'Basic', deckName: 'Default', tags: ['quick-search'],
      fields: { Front: 'Quick search tag', Back: 'Smoke test' },
    }),
  }).then(response => response.json()).then(payload => { if (!payload.ok) throw new Error(payload.error); })`);
  await evaluate("document.dispatchEvent(new Event('anki-agent-finished'))");
  await until(async () => (await quickSearchLabels()).includes('TAGS'));
  assert.deepEqual(await quickSearchLabels(), ['RECENT', 'CARD STATE', 'FLAGS', 'NOTE TYPES', 'DECKS', 'TAGS']);
  // The NOTE TYPES group offers every note type the collection holds with the configured default first, so it is
  // compared with what the APIs answer: a literal list would restate the bundled Anki's defaults and the note
  // type the app seeds, and go stale as soon as either changes.
  const expectedNoteTypes = await evaluate(`Promise.all([
    fetch('/api/anki/models?select=name').then(response => response.json()),
    fetch('/api/anki-settings').then(response => response.json()),
  ]).then(([models, settings]) => [
    settings.modelName,
    ...models.models.map(model => model.name).filter(name => name !== settings.modelName),
  ])`);
  assert.deepEqual(await evaluate(`(() => {
    const red = document.querySelector('[data-group-id="flags"] .anki-quick-item');
    const noteTypes = Array.from(document.querySelectorAll('[data-group-id="note-types"] .anki-quick-item'));
    const tag = document.querySelector('[data-group-id="tags"] .anki-quick-item');
    return {
      red: { text: red.textContent, query: red.dataset.query, background: getComputedStyle(red).backgroundColor,
        color: getComputedStyle(red).color },
      noteTypes: noteTypes.map(item => item.textContent), tag: tag.textContent,
    };
  })()`), {
    red: { text: 'Red', query: 'flag:1', background: 'rgb(208, 69, 62)', color: 'rgb(0, 0, 0)' },
    noteTypes: expectedNoteTypes, tag: 'quick-search',
  });
  await evaluate(`(() => {
    for (let index = 0; index < 5; index++) {
      const head = document.querySelector('[data-group-id="tags"] .anki-quick-group-head');
      head.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowUp', altKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
    }
  })()`);
  await until(async () => (await quickSearchLabels())[0] === 'TAGS');
  await delay(300);
  const quickSearchReloadStamp = await evaluate('performance.timeOrigin');
  await evaluate('location.reload()');
  await until(async () => await evaluate('performance.timeOrigin') !== quickSearchReloadStamp);
  await until(async () => (await quickSearchLabels()).length === 6);
  assert.equal((await quickSearchLabels())[0], 'TAGS');
  console.log('PASS: quick search loads tags, simplifies labels, colors flags, and persists category order');
  await evaluate("document.querySelector('#ankiEditNoteType').click()");
  await until(async () => await evaluate(`(() => {
    const dialog = document.querySelector('#ankiNoteTypeDialog');
    return dialog.open && document.querySelector('#ankiNoteTypeSelect').options.length
      && document.querySelectorAll('#ankiNoteTypeFields .anki-note-type-field-name').length;
  })()`));
  assert.deepEqual(await evaluate(`(() => {
    const dialog = document.querySelector('#ankiNoteTypeDialog');
    const body = dialog.querySelector('.dialog-body');
    const status = document.querySelector('#ankiNoteTypeStatus');
    const select = document.querySelector('#ankiNoteTypeSelect');
    const fieldsPanel = document.querySelector('#ankiNoteTypeFieldsPanel');
    const cardsPanel = document.querySelector('#ankiNoteTypeCardsPanel');
    const row = document.querySelector('#ankiNoteTypeFields .anki-schema-row-main');
    const picker = dialog.querySelector('.anki-picker-row');
    const title = document.querySelector('#ankiNoteTypeTitle');
    const sortRadios = [...document.querySelectorAll('#ankiNoteTypeFields .anki-field-sort')];
    const selected = [...document.querySelectorAll('.anki-note-type-tab')]
      .filter(tab => tab.getAttribute('aria-selected') === 'true');
    const buttons = [...dialog.querySelectorAll('button')];
    return {
      width: Math.abs(dialog.clientWidth - body.offsetWidth) <= 2,
      // The status line is written on the title's own line, in the head that no panel can scroll away. A status
      // with nothing to say is hidden outright, so its place on that line is only measured while it shows text.
      statusPinned: status.parentElement === title.parentElement
        && !status.closest('.anki-note-type-panel')
        && (!status.textContent.trim() || (status.getBoundingClientRect().top < title.getBoundingClientRect().bottom
          && status.getBoundingClientRect().bottom > title.getBoundingClientRect().top)),
      // The header is one row and one control: the note type list, the name to rename, the name for a new one,
      // and the confirm and return icons in that order, with the destructive delete apart at the far end.
      pickerRow: Boolean(picker)
        && picker.children.length === 6
        && picker.querySelector('#ankiNoteTypeSelect') === select
        && select.nextElementSibling?.id === 'ankiNoteTypeName'
        && picker.lastElementChild?.id === 'ankiDeleteNoteType'
        && !document.querySelector('#ankiCreateNoteType')
        && !document.querySelector('#ankiRenameNoteType')
        && !select.hidden && select.options.length > 1
        && select.options[0].value === '- New Note Type -'
        && select.options[0].textContent === '- New Note Type -'
        && select.getBoundingClientRect().width > picker.getBoundingClientRect().width / 2,
      // The sort field is a radio on each field's own row, and the header holds no copy of it.
      sortField: !document.querySelector('#ankiNoteTypeSortField')
        && sortRadios.length === document.querySelectorAll('#ankiNoteTypeFields .anki-schema-row').length
        && sortRadios.every(radio => radio.type === 'radio' && radio.name === 'ankiNoteTypeSortField')
        && sortRadios.filter(radio => radio.checked).length === 1,
      // A row says nothing about its own settings, so no state text sits beside the name.
      noSummary: !document.querySelector('#ankiNoteTypeFields .anki-field-summary'),
      // The field list scrolls and resizes on its own, and it is taller than a row or two.
      fieldsPane: getComputedStyle(fieldsPanel).resize === 'vertical'
        && getComputedStyle(fieldsPanel).overflowY === 'auto'
        && fieldsPanel.getBoundingClientRect().height >= 220,
      tabs: selected.length === 1 && selected[0].id === 'ankiNoteTypeFieldsTab'
        && document.querySelectorAll('.anki-note-type-tab[aria-controls]').length === 2
        && !fieldsPanel.hidden && cardsPanel.hidden,
      // A field row saves itself: a name input and its settings, movement and removal controls, and no save button.
      fieldRow: Boolean(row.querySelector('.anki-note-type-field-name'))
        && Boolean(row.querySelector('.anki-note-type-field-settings'))
        && row.querySelectorAll('.anki-note-type-field-move').length === 2
        && Boolean(row.querySelector('.anki-note-type-field-delete'))
        && !row.querySelector('.anki-note-type-field-save'),
      // An icon-only control carries its words, and a labelled one shows them.
      buttons: buttons.every(button => (button.classList.contains('button-icon')
        ? Boolean(button.ariaLabel && button.title) : Boolean(button.textContent.trim()))),
      fieldButtons: [...dialog.querySelectorAll('#ankiNoteTypeFields .button-icon')].every(button => {
        const { width, height } = button.getBoundingClientRect();
        return Math.abs(width - height) < 1;
      }),
      // One field's settings are unfolded at a time: opening a row folds the one that was already open.
      accordion: (() => {
        const toggle = index => document
          .querySelectorAll('#ankiNoteTypeFields .anki-note-type-field-settings')[index].click();
        const panes = () => document.querySelectorAll('#ankiNoteTypeFields .anki-field-settings').length;
        const openIndex = () => [...document.querySelectorAll('#ankiNoteTypeFields .anki-schema-row')]
          .findIndex(item => item.querySelector('.anki-field-settings'));
        toggle(0);
        const opened = panes() === 1 && openIndex() === 0;
        toggle(1);
        const moved = panes() === 1 && openIndex() === 1;
        toggle(1);
        return opened && moved && panes() === 0;
      })(),
    };
  })()`), {
    width: true, statusPinned: true, pickerRow: true, sortField: true, noSummary: true, fieldsPane: true,
    tabs: true, fieldRow: true, buttons: true, fieldButtons: true, accordion: true,
  });
  // The row is one control that changes what it is: the confirm button opens the rename form for the note type
  // the list shows, the return button gives the list back, and the entry that is not a note type is a choice of
  // its own, so choosing it opens the form that names a new one — each with its own confirm, whose icon names the
  // step it takes. A form gives the list back when its own input loses the focus its mode gave it, and writes
  // nothing on the way out.
  const pickerCycle = await evaluate(`(() => {
    const $ = selector => document.querySelector(selector);
    const select = $('#ankiNoteTypeSelect');
    const name = $('#ankiNoteTypeName');
    const fresh = $('#ankiNewNoteTypeName');
    const confirm = $('#ankiNoteTypeConfirm');
    const back = $('#ankiNoteTypeReturn');
    const icon = () => confirm.querySelector('use').getAttribute('href');
    const label = () => confirm.getAttribute('aria-label');
    const shown = () => ({
      list: !select.hidden, rename: !name.hidden, create: !fresh.hidden, back: !back.hidden,
    });
    const lit = select.value;
    const closing = { ...shown(), icon: icon(), label: label() };
    confirm.click();
    const renaming = { ...shown(), icon: icon(), filled: name.value === lit,
      focused: document.activeElement === name };
    back.click();
    const returned = { ...shown(), icon: icon(), label: label() };
    // Choosing the entry that is not a note type opens the form for a new one: there is nothing to name it after
    // until the user types the name, so the list is not left waiting for a second click on its confirm.
    select.value = '- New Note Type -';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const creating = { ...shown(), icon: icon(), empty: fresh.value === '',
      focused: document.activeElement === fresh };
    // The form is the row's own state, so focus landing anywhere else is the user back at the list.
    fresh.blur();
    const left = { ...shown(), icon: icon(), label: label(), value: select.value };
    return { lit, closing, renaming, returned, creating, left };
  })()`);
  assert.deepEqual(pickerCycle, {
    lit: pickerCycle.lit,
    closing: { list: true, rename: false, create: false, back: false, icon: '#i-pencil',
      label: `Rename ${pickerCycle.lit}` },
    renaming: { list: false, rename: true, create: false, back: true, icon: '#i-check-circle', filled: true,
      focused: true },
    returned: { list: true, rename: false, create: false, back: false, icon: '#i-pencil',
      label: `Rename ${pickerCycle.lit}` },
    creating: { list: false, rename: false, create: true, back: true, icon: '#i-check-circle', empty: true,
      focused: true },
    left: { list: true, rename: false, create: false, back: false, icon: '#i-pencil',
      label: `Rename ${pickerCycle.lit}`, value: pickerCycle.lit },
  });
  const studioRowGaps = await rowFieldGaps();
  assert.ok(studioRowGaps.length >= 2 && studioRowGaps.every(gap => gap === 0),
    `a field and its row button differ in height: ${studioRowGaps}`);
  await evaluate("document.querySelector('#ankiNoteTypeCardsTab').click()");
  assert.deepEqual(await evaluate(`(() => ({
    cards: document.querySelector('#ankiNoteTypeCardsPanel').hidden === false,
    fields: document.querySelector('#ankiNoteTypeFieldsPanel').hidden === true,
    on: document.querySelector('#ankiNoteTypeCardsTab').getAttribute('aria-selected'),
    off: document.querySelector('#ankiNoteTypeFieldsTab').getAttribute('aria-selected'),
  }))()`), { cards: true, fields: true, on: 'true', off: 'false' });
  assert.deepEqual(await evaluate(`(() => {
    const select = document.querySelector('#ankiNoteTypeTemplateSelect');
    const row = select.parentElement;
    const source = document.querySelector('#ankiNoteTypeTemplateSource');
    const labels = [...document.querySelectorAll('.anki-template-source-label')];
    return {
      // The card list is the shared row over one note type's own templates, and the field a new card starts on
      // belongs to the create step alone, so it is in the row and hidden until that step is taken.
      row: row.classList.contains('anki-picker-row')
        && row.children.length === 7
        && select.nextElementSibling?.id === 'ankiNoteTypeTemplateName'
        && select.nextElementSibling?.nextElementSibling?.id === 'ankiNewNoteTypeTemplate'
        && select.nextElementSibling?.nextElementSibling?.nextElementSibling?.id
          === 'ankiNewNoteTypeTemplateField'
        && row.lastElementChild?.id === 'ankiDeleteNoteTypeTemplate'
        && select.options[0].value === '- New Card -' && !select.hidden
        && !document.querySelector('#ankiAddNoteTypeTemplate'),
      field: document.querySelector('#ankiNewNoteTypeTemplateField').hidden === true,
      // A card's whole source is one box behind the three parts a card has, and the box shows the part of the card
      // on screen: nothing about it is written until it is typed in, so it needs no save button of its own.
      source: labels.length === 3
        && labels.map(label => label.dataset.templateSource).join() === 'front,back,styling'
        && labels.map(label => label.getAttribute('aria-pressed')).join() === 'true,false,false'
        && document.querySelector('#ankiNoteTypeTemplateSourceLabel').textContent === 'Front template',
      editing: source.tagName === 'TEXTAREA' && source.value.length > 0
        && !document.querySelector('#ankiSaveNoteTypeTemplate'),
    };
  })()`), { row: true, field: true, source: true, editing: true });
  // The field a new card starts on offers the note type's own field names, which is what its value has to be: the
  // model holds each field as its settings, and offering that object rendered every option as `{{[object Object]}}`
  // and left the select with nothing selected. Choosing one is still the create form, and the row's way back is
  // the one thing that gives the list back.
  assert.deepEqual(await evaluate(`(() => {
    const list = document.querySelector('#ankiNoteTypeTemplateSelect');
    const create = document.querySelector('#ankiNewNoteTypeTemplate');
    const field = document.querySelector('#ankiNewNoteTypeTemplateField');
    list.value = '- New Card -';
    list.dispatchEvent(new Event('change', { bubbles: true }));
    const options = Array.from(field.options);
    const creating = list.hidden && !create.hidden && !field.hidden && create.value === '';
    // Opening the field list takes the focus off the name box; that is still the create form, not the list.
    create.dispatchEvent(new FocusEvent('blur', { relatedTarget: field }));
    const kept = list.hidden && !create.hidden && !field.hidden;
    document.querySelector('#ankiNoteTypeTemplateReturn').click();
    return {
      creating,
      names: options.length > 0 && options.every(option => /^\\{\\{[^{}]+\\}\\}$/.test(option.textContent)
        && option.value === option.textContent.slice(2, -2)),
      selected: options.some(option => option.value === field.value),
      kept,
      back: !list.hidden && field.hidden && create.hidden,
    };
  })()`), { creating: true, names: true, selected: true, kept: true, back: true });
  // The three parts of a card are one source under three labels, so switching labels swaps what the box holds and
  // leaves exactly the label that is showing marked — the box is never rebuilt, and the part that was on screen is
  // captured before another is shown.
  assert.deepEqual(await evaluate(`(() => {
    const source = document.querySelector('#ankiNoteTypeTemplateSource');
    const text = document.querySelector('#ankiNoteTypeTemplateSourceLabel');
    const label = id => document.querySelector('[data-template-source="' + id + '"]');
    const active = () => [...document.querySelectorAll('.anki-template-source-label')]
      .filter(item => item.getAttribute('aria-pressed') === 'true')
      .map(item => item.dataset.templateSource).join();
    const onFront = { label: text.textContent, value: source.value, active: active() };
    label('back').click();
    const onBack = { label: text.textContent, active: active() };
    label('styling').click();
    const onStyling = { label: text.textContent, active: active() };
    label('front').click();
    return {
      names: onFront.label === 'Front template' && onBack.label === 'Back template'
        && onStyling.label === 'Styling (shared by every card)',
      marks: onFront.active === 'front' && onBack.active === 'back' && onStyling.active === 'styling',
      restored: text.textContent === 'Front template' && active() === 'front'
        && source.value === onFront.value,
    };
  })()`), { names: true, marks: true, restored: true });
  // A card write repaints the card row and the source under it, because the card is what changed: the card the row
  // now shows is the one the write left open, and the box holds that card's own source rather than the source of
  // the card it replaced. Deleting the card puts the pair back where they were.
  const cardBefore = await evaluate(`(() => {
    const source = document.querySelector('#ankiNoteTypeTemplateSource');
    const label = id => document.querySelector('[data-template-source="' + id + '"]');
    const read = id => { label(id).click(); return source.value; };
    return {
      name: document.querySelector('#ankiNoteTypeTemplateSelect').value,
      front: read('front'),
      back: read('back'),
    };
  })()`);
  const newCardFront = await evaluate(`(() => {
    const select = document.querySelector('#ankiNoteTypeTemplateSelect');
    select.value = '- New Card -';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const field = document.querySelector('#ankiNewNoteTypeTemplateField').value;
    document.querySelector('#ankiNewNoteTypeTemplate').value = 'Smoke Card';
    document.querySelector('#ankiNoteTypeTemplateConfirm').click();
    return '{{' + field + '}}';
  })()`);
  await until(async () => await evaluate(
    "document.querySelector('#ankiNoteTypeStatus').textContent === 'Added card Smoke Card'"));
  assert.deepEqual(await evaluate(`(() => {
    const source = document.querySelector('#ankiNoteTypeTemplateSource');
    const label = id => document.querySelector('[data-template-source="' + id + '"]');
    const read = id => { label(id).click(); return source.value; };
    return {
      name: document.querySelector('#ankiNoteTypeTemplateSelect').value,
      listing: !document.querySelector('#ankiNoteTypeTemplateSelect').hidden,
      front: read('front'),
      back: read('back'),
    };
  })()`), { name: 'Smoke Card', listing: true, front: newCardFront, back: '{{FrontSide}}<hr id=answer>' });
  await evaluate(`(() => {
    const button = document.querySelector('#ankiDeleteNoteTypeTemplate');
    button.click();
    button.click();
  })()`);
  await until(async () => await evaluate(
    "document.querySelector('#ankiNoteTypeStatus').textContent === 'Deleted card Smoke Card'"));
  assert.deepEqual(await evaluate(`(() => {
    const source = document.querySelector('#ankiNoteTypeTemplateSource');
    const label = id => document.querySelector('[data-template-source="' + id + '"]');
    const read = id => { label(id).click(); return source.value; };
    return {
      name: document.querySelector('#ankiNoteTypeTemplateSelect').value,
      front: read('front'),
      back: read('back'),
    };
  })()`), cardBefore);
  await evaluate("document.querySelector('#ankiNoteTypeFieldsTab').click()");
  window.setSize(640, 800);
  await delay(200);
  assert.equal(await evaluate(`(() => {
    const rect = document.querySelector('#ankiNoteTypeDialog').getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
  })()`), true);
  // The field list is the part that gives way when the window is short, so the dialog's bottom edge stays inside
  // it: the pane shrinks to its own floor and the content region scrolls rather than hiding what did not fit.
  window.setSize(640, 560);
  await delay(200);
  assert.deepEqual(await evaluate(`(() => {
    const dialog = document.querySelector('#ankiNoteTypeDialog');
    const rect = dialog.getBoundingClientRect();
    return {
      inside: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      scrollable: getComputedStyle(dialog.querySelector('.dialog-content')).overflowY === 'auto',
      pane: document.querySelector('#ankiNoteTypeFieldsPanel').getBoundingClientRect().height >= 140,
    };
  })()`), { inside: true, scrollable: true, pane: true });
  window.setSize(640, 800);
  await delay(200);
  await evaluate(`(() => {
    const select = document.querySelector('#ankiNoteTypeSelect');
    select.value = '- New Note Type -';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#ankiNewNoteTypeName').value = 'Smoke Note Type';
    document.querySelector('#ankiNoteTypeConfirm').click();
  })()`);
  await until(async () => await evaluate(`(() => {
    const select = document.querySelector('#ankiNoteTypeSelect');
    return select.value === 'Smoke Note Type' && !select.disabled;
  })()`));
  await evaluate(`(() => {
    const button = document.querySelector('#ankiDeleteNoteType');
    button.click();
    button.click();
  })()`);
  await until(async () => await evaluate(`(() => {
    const select = document.querySelector('#ankiNoteTypeSelect');
    return !select.disabled && ![...select.options].some(option => option.value === 'Smoke Note Type');
  })()`));
  await evaluate("document.querySelector('#ankiNoteTypeDialog [data-dialog-close]').click()");
  await until(async () => await evaluate("!document.querySelector('#ankiNoteTypeDialog').open"));
  window.setSize(1400, 950);
  console.log('PASS: Note Type Studio fills its dialog, uses icon controls, and fits narrow windows');
  // Deck Studio is the same row over decks, and it is the studio whose list can hold the one deck Anki refuses
  // to rename, so what the confirm button does there is derived from the deck the collection actually selected
  // rather than assumed.
  await evaluate("document.querySelector('#ankiManageDecks').click()");
  await until(async () => await evaluate("document.querySelector('#ankiDeckDialog').open"
    + " && document.querySelector('#ankiDeckSelect').options.length > 1"));
  const deckCycle = await evaluate(`(() => {
    const $ = selector => document.querySelector(selector);
    const select = $('#ankiDeckSelect');
    const name = $('#ankiDeckName');
    const fresh = $('#ankiNewDeckName');
    const confirm = $('#ankiDeckConfirm');
    const back = $('#ankiDeckReturn');
    const row = select.parentElement;
    const icon = () => confirm.querySelector('use').getAttribute('href');
    const label = () => confirm.getAttribute('aria-label');
    const shown = () => ({
      list: !select.hidden, rename: !name.hidden, create: !fresh.hidden, back: !back.hidden,
    });
    const renameableOption = [...select.options]
      .find(option => option.value !== 'Default' && option.value !== '- New Deck -');
    if (renameableOption) {
      select.value = renameableOption.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const lit = select.value;
    const shape = {
      children: row.children.length,
      order: [...row.children].map(element => element.id).join(','),
      sentinel: select.options[0].textContent,
      listed: select.options.length > 1,
      oneRow: Math.round(row.getBoundingClientRect().height) <= 44,
      legacy: !$('#ankiCreateDeck') && !$('#ankiRenameDeck'),
    };
    const closing = { ...shown(), icon: icon(), label: label(), deleteHidden: $('#ankiDeleteDeck').hidden };
    // Anki files every unnamed note under the default deck and refuses to rename or delete it, so the row
    // offers neither step for it — which is what its own confirm button says.
    const renameable = !confirm.disabled;
    if (renameable) confirm.click();
    const renaming = renameable
      ? { ...shown(), icon: icon(), filled: name.value === lit, focused: document.activeElement === name }
      : null;
    if (renameable) back.click();
    const returned = { ...shown(), icon: icon(), label: label() };
    select.value = '- New Deck -';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const creating = { ...shown(), icon: icon(), empty: fresh.value === '',
      focused: document.activeElement === fresh };
    fresh.blur();
    const left = { ...shown(), icon: icon(), label: label(), value: select.value };
    return { lit, shape, closing, renameable, renaming, returned, creating, left };
  })()`);
  assert.deepEqual(deckCycle, {
    lit: deckCycle.lit,
    shape: { children: 6,
      order: 'ankiDeckSelect,ankiDeckName,ankiNewDeckName,ankiDeckConfirm,ankiDeckReturn,ankiDeleteDeck',
      sentinel: '- New Deck -', listed: true, oneRow: true, legacy: true },
    closing: { list: true, rename: false, create: false, back: false, icon: '#i-pencil',
      label: `Rename ${deckCycle.lit}`, deleteHidden: false },
    renameable: deckCycle.lit !== 'Default',
    renaming: deckCycle.renameable
      ? { list: false, rename: true, create: false, back: true, icon: '#i-check-circle', filled: true,
        focused: true }
      : null,
    returned: { list: true, rename: false, create: false, back: false, icon: '#i-pencil',
      label: `Rename ${deckCycle.lit}` },
    creating: { list: false, rename: false, create: true, back: true, icon: '#i-check-circle', empty: true,
      focused: true },
    left: { list: true, rename: false, create: false, back: false, icon: '#i-pencil',
      label: `Rename ${deckCycle.lit}`, value: deckCycle.lit },
  });
  const deckRowGaps = await rowFieldGaps();
  assert.ok(deckRowGaps.length >= 2 && deckRowGaps.every(gap => gap === 0),
    `a deck control and its row button differ in height: ${deckRowGaps}`);
  await evaluate("document.querySelector('#ankiDeckDialog [data-dialog-close]').click()");
  await until(async () => await evaluate("!document.querySelector('#ankiDeckDialog').open"));
  console.log('PASS: Deck Studio picks, creates, renames and deletes from one row');
  // Study Options is that same row a third time, over Anki's own deck-option presets, and it is the one studio
  // that draws a form of its own under the row — so it is where the row and the dialog's own rendering have to
  // agree about which mode they are in.
  await evaluate("document.querySelector('#ankiStudyOptions').click()");
  await until(async () => await evaluate("document.querySelector('#ankiStudyOptionsDialog').open"
    + " && document.querySelector('#ankiStudyOptionSelect').options.length > 1"));
  const presetCycle = await evaluate(`(() => {
    const $ = selector => document.querySelector(selector);
    const select = $('#ankiStudyOptionSelect');
    const name = $('#ankiStudyOptionName');
    const fresh = $('#ankiNewStudyOptionName');
    const confirm = $('#ankiStudyOptionConfirm');
    const back = $('#ankiStudyOptionReturn');
    const row = select.parentElement;
    const icon = () => confirm.querySelector('use').getAttribute('href');
    const label = () => confirm.getAttribute('aria-label');
    const shown = () => ({
      list: !select.hidden, rename: !name.hidden, create: !fresh.hidden, back: !back.hidden,
    });
    const presetOption = [...select.options].find(option => option.value !== '- New Study Options -');
    if (presetOption) {
      select.value = presetOption.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const lit = select.selectedOptions[0].textContent;
    const shape = {
      children: row.children.length,
      order: [...row.children].map(element => element.id).join(','),
      sentinel: select.options[0].textContent,
      legacy: !$('#ankiCreateStudyOption') && !$('#ankiRenameStudyOption'),
      help: $('#ankiStudyOptionHelp').textContent.length > 0,
    };
    const closing = { ...shown(), icon: icon(), label: label(),
      deleteHidden: $('#ankiDeleteStudyOption').hidden };
    // Anki's own preset is what a deck naming none falls back to, so the row offers it no rename — which is
    // what its own confirm button says, for the same reason it does in the deck list.
    const renameable = !confirm.disabled;
    if (renameable) confirm.click();
    const renaming = renameable
      ? { ...shown(), icon: icon(), filled: name.value === lit, focused: document.activeElement === name }
      : null;
    if (renameable) back.click();
    const returned = { ...shown(), icon: icon(), label: label() };
    select.value = '- New Study Options -';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const creating = { ...shown(), icon: icon(), empty: fresh.value === '',
      focused: document.activeElement === fresh };
    fresh.blur();
    const left = { ...shown(), icon: icon(), label: label(), value: select.selectedOptions[0].textContent };
    return { lit, shape, closing, renameable, renaming, returned, creating, left };
  })()`);
  assert.deepEqual(presetCycle, {
    lit: presetCycle.lit,
    shape: { children: 6,
      order: 'ankiStudyOptionSelect,ankiStudyOptionName,ankiNewStudyOptionName,ankiStudyOptionConfirm,'
        + 'ankiStudyOptionReturn,ankiDeleteStudyOption',
      sentinel: '- New Study Options -', legacy: true, help: true },
    closing: { list: true, rename: false, create: false, back: false, icon: '#i-pencil',
      label: `Rename ${presetCycle.lit}`, deleteHidden: false },
    renameable: presetCycle.lit !== 'Default',
    renaming: presetCycle.renameable
      ? { list: false, rename: true, create: false, back: true, icon: '#i-check-circle', filled: true,
        focused: true }
      : null,
    returned: { list: true, rename: false, create: false, back: false, icon: '#i-pencil',
      label: `Rename ${presetCycle.lit}` },
    creating: { list: false, rename: false, create: true, back: true, icon: '#i-check-circle', empty: true,
      focused: true },
    left: { list: true, rename: false, create: false, back: false, icon: '#i-pencil',
      label: `Rename ${presetCycle.lit}`, value: presetCycle.lit },
  });
  const presetRowGaps = await rowFieldGaps();
  assert.ok(presetRowGaps.length >= 1 && presetRowGaps.every(gap => gap === 0),
    `a study options control and its row button differ in height: ${presetRowGaps}`);
  await delay(300);
  await evaluate("document.querySelector('#ankiStudyOptionsDialog [data-dialog-close]').click()");
  await until(async () => await evaluate("!document.querySelector('#ankiStudyOptionsDialog').open"));
  console.log('PASS: Study Options picks, creates, renames and deletes from one row');
  assert.equal(await evaluate("document.querySelector('#ankiSelectedAi').title.includes('⌘ + G')"), true);
  await evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }));
  })()`);
  await until(async () => await evaluate("document.querySelector('#ankiNoteEditor').hidden === false"));
  assert.equal(await evaluate(`(() => {
    const editor = document.querySelector('#ankiNoteEditor');
    const body = editor.querySelector('.anki-note-body');
    const footer = editor.querySelector('.anki-note-footer');
    const suggestions = footer.querySelector('.anki-tag-suggestions');
    const styles = getComputedStyle(suggestions);
    return footer.previousElementSibling === body
      && getComputedStyle(body).overflowY === 'auto'
      && getComputedStyle(footer).flexShrink === '0'
      && styles.top === 'auto'
      && styles.bottom !== 'auto';
  })()`), true);
  console.log('PASS: note shortcuts load and dispatch in the renderer');
  await delay(500);
  // A watched-source change is answered on the watcher's own debounce, and a backend change also restarts the
  // backend process, so both waits carry a larger budget than a state assertion.
  let stamp = await evaluate('performance.timeOrigin');
  touch('frontend/index.html');
  await until(async () => await evaluate('performance.timeOrigin') !== stamp,
    () => 'the window never reloaded after the frontend source change', 300);
  console.log('PASS: frontend changes reload the window');
  await delay(500);
  stamp = await evaluate('performance.timeOrigin');
  touch('backend/server.js');
  await until(async () => await evaluate('performance.timeOrigin') !== stamp,
    () => 'the window never reloaded after the backend source change', 300);
  console.log('PASS: backend changes restart and reconnect');
  for (const width of [900, 640]) {
    window.setSize(width, 800);
    await delay(200);
    assert.equal(await evaluate(`(() => {
      const search = document.querySelector('#ankiSearchForm').getBoundingClientRect();
      const chat = document.querySelector('#ankiChat').getBoundingClientRect();
      return chat.top >= search.bottom;
    })()`), true);
  }
  window.setSize(1400, 950);
  console.log('PASS: expanded Anki Agent stays below search at narrow widths');
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
    "document.querySelector('#ankiSettingsStatus').classList.contains('is-error')"));
  // The collection-profile row is the settings dialog's own, and it states a shorter height than a studio's.
  await evaluate("document.querySelector('#ankiSettingsTab').click()");
  await until(async () => await evaluate("document.querySelector('#ankiSettingsPanel').hidden === false"
    + " && document.querySelector('#ankiSettingsPanel').getAttribute('aria-busy') === 'false'"));
  const settingsRowGaps = await rowFieldGaps();
  assert.ok(settingsRowGaps.length >= 1 && settingsRowGaps.every(gap => gap === 0),
    `a field and its row button differ in height: ${settingsRowGaps}`);
  console.log('PASS: Quick settings fits a narrow window and renders validation errors');
  console.log('PASS: isolated desktop smoke test; closing app');
  window.close();
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
  app.quit();
});
