const runStudiosSmoke = async ({ assert, delay, evaluate, rowFieldGaps, until, window }) => {
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
};

module.exports = { runStudiosSmoke };

