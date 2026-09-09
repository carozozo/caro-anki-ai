const runEditorSmoke = async ({ assert, delay, evaluate, until }) => {
await until(async () => await evaluate(`(() => {
  const select = document.querySelector('#ankiSearchPrefix');
  return Boolean(select.querySelector('option[value="added"]') && select.querySelector('option[value="Front"]'));
})()`));
const searchPrefixState = await evaluate(`(() => {
  const select = document.querySelector('#ankiSearchPrefix');
  const query = document.querySelector('#ankiQuery');
  select.value = 'added';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return {
    value: query.value, focused: document.activeElement === query,
    selection: [query.selectionStart, query.selectionEnd],
    quick: [...select.querySelectorAll('optgroup[label="Quick search"] option')].map(option => option.value),
    fields: [...select.querySelectorAll('optgroup[label="Card fields"] option')].map(option => option.value),
  };
})()`);
assert.equal(searchPrefixState.value, 'added:');
assert.equal(searchPrefixState.focused, true);
assert.deepEqual(searchPrefixState.selection, [6, 6]);
assert.ok(searchPrefixState.quick.includes('rated'));
assert.ok(searchPrefixState.fields.includes('Front'));
console.log('PASS: search prefix fills the query and lands its caret at the end');
await evaluate("document.querySelector('#ankiNewNote').click()");
await until(async () => await evaluate("document.querySelector('#ankiChangeDeck').disabled === false"));
await evaluate("document.querySelector('#ankiChangeDeck').click()");
await until(async () => await evaluate("document.querySelector('#ankiBatchDialog').open"));
await evaluate("document.querySelector('#ankiBatchDialog [data-dialog-close]').click()");
await until(async () => await evaluate("!document.querySelector('#ankiBatchDialog').open"));
await evaluate("document.querySelector('#ankiChangeDeck').click()");
await until(async () => await evaluate("document.querySelector('#ankiBatchDialog').open"));
await evaluate("document.querySelector('#ankiBatchDialog [data-dialog-close]').click()");
await evaluate("document.querySelector('.anki-note-close').click()");
await until(async () => await evaluate("document.querySelector('#ankiNoteEditor').hidden"));
console.log('PASS: a new-note Change deck dialog reopens after dismissal');
const createSmokeNote = async value => {
  const count = await evaluate("document.querySelectorAll('.anki-note-row').length");
  await evaluate("document.querySelector('#ankiNewNote').click()");
  await until(async () => await evaluate("!document.querySelector('#ankiNoteEditor').hidden"));
  await evaluate(`(() => {
    const input = document.querySelector('.anki-note-input');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.anki-note-save').click();
  })()`);
  await until(async () => await evaluate("document.querySelector('.anki-note-input').value === ''"));
  await evaluate("document.querySelector('.anki-note-close').click()");
  await until(async () => await evaluate("document.querySelector('#ankiNoteEditor').hidden"
    + ` && document.querySelectorAll('.anki-note-row').length > ${count}`));
};
await createSmokeNote('editor navigation A');
await createSmokeNote('editor navigation B');
await evaluate(`(() => {
  const row = [...document.querySelectorAll('.anki-note-row')].at(-1);
  row.click();
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
})()`);
await until(async () => await evaluate("!document.querySelector('#ankiNoteEditor').hidden"));
const editorId = await evaluate("document.querySelector('.anki-note-id').textContent");
await evaluate("document.querySelector('.anki-rich-toggle').click()");
await until(async () => await evaluate(`(() => {
  const field = document.querySelector('.anki-rich-field');
  return field.classList.contains('is-editing') && document.activeElement === field.querySelector('textarea');
})()`));
await evaluate("document.querySelector('#ankiPreviousNote').click()");
await until(async () => await evaluate(`(() => {
  const field = document.querySelector('.anki-rich-field');
  return document.querySelector('.anki-note-id').textContent !== ${JSON.stringify(editorId)}
    && field.classList.contains('is-editing') && document.activeElement === field.querySelector('textarea');
})()`));
await evaluate("document.querySelector('.anki-rich-toggle').click()");
await until(async () => await evaluate(`(() => {
  const frame = document.querySelector('.anki-rich-view');
  const body = frame.contentDocument?.body;
  const selection = body?.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  return body?.dataset.bound === 'true' && frame.contentDocument.activeElement === body
    && range?.collapsed && body.contains(range.commonAncestorContainer);
})()`));
await evaluate("document.querySelector('#ankiNextNote').click()");
await until(async () => await evaluate(`(() => {
  const frame = document.querySelector('.anki-rich-view');
  const body = frame.contentDocument?.body;
  const selection = body?.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  return document.querySelector('.anki-note-id').textContent === ${JSON.stringify(editorId)}
    && !document.querySelector('.anki-rich-field').classList.contains('is-editing')
    && frame.contentDocument.activeElement === body && range?.collapsed
    && body.contains(range.commonAncestorContainer);
})()`));
await delay(600);
const richFocus = await evaluate(`(() => {
  const fields = [...document.querySelectorAll('.anki-rich-field')];
  const first = fields[0];
  const second = fields[1];
  second.querySelector('.anki-rich-view').contentDocument.body.focus();
  return new Promise(resolve => setTimeout(() => resolve({
    first: first.classList.contains('is-focused'), second: second.classList.contains('is-focused'),
  }), 600));
})()`);
assert.deepEqual(richFocus, { first: false, second: true });
console.log('PASS: editor navigation keeps its caret, mode, and one focused field');
};

const runEditorShortcutSmoke = async ({ assert, evaluate, until }) => {
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
};

module.exports = { runEditorShortcutSmoke, runEditorSmoke };

