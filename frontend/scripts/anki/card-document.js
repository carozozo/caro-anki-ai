((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CardDocument = api;
})(globalThis, () => {
  // Every note field stores Anki card HTML (`<br>`, `<b>`, `<div>`), and both a field and a card preview are
  // documents the note type's own styling was written for: Anki's `.card` rule states the ink for a light
  // background, which is unreadable on this app's dark panels. So a document states its own surface and base
  // ink *after* that styling — `body.card` outranks the card's own `.card` rule — while the card's remaining
  // rules, `!important` colours included, still win for the elements they name. A field and a card preview
  // differ in one thing only: the preview is the card's own page and fills its frame, while a field keeps the
  // app's surface and states no height, because a card page's `min-height: 100%` would grow the frame by the
  // height the frame just took, on every resize.
  const themeToken = (name, fallback) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const previewKeyboardEventType = 'anki-card-preview-keydown';
  const previewKeyboardBridge = `<script>addEventListener('keydown', event => {
  if (!event.metaKey && !event.ctrlKey && event.key !== 'Escape') return;
  parent.postMessage({
    type: '${previewKeyboardEventType}',
    key: event.key,
    code: event.code,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  }, '*');
}, true);</script>`;

  const cardShell = ({ background, padding, minHeight = '' }) => `:root { color-scheme: dark; }
html, body { margin: 0; ${minHeight}background: ${background}; }
body.card { padding: ${padding}; color: ${themeToken('--ink', '#e4edf9')}; }
/* An empty field still has to read as one, and a pseudo-element keeps the hint out of the value. */
body.card:empty::before { color: ${themeToken('--muted', '#9aaecb')}; content: 'Empty'; }`;

  // A field's value is user data, so a preview renders it with the scripts and the event handlers taken out;
  // the textarea stays the single source of truth for what the field holds.
  const richFieldHtml = value => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = String(value ?? '');
    wrapper.querySelectorAll('script, style, iframe, object, embed').forEach(element => element.remove());
    wrapper.querySelectorAll('*').forEach(element => {
      [...element.attributes].forEach(({ name, value: attribute }) => {
        if (/^on/i.test(name)) element.removeAttribute(name);
        else if (/^(?:href|src)$/i.test(name) && /^\s*javascript:/i.test(attribute)) {
          element.removeAttribute(name);
        }
      });
    });
    return wrapper.innerHTML;
  };

  // Chromium keeps a trailing `<br>` to hold a caret line at the end of the content, and a *real* trailing
  // break is only visible through that extra `<br>` (a lone trailing `<br>` renders no line). So the stored
  // value is the rendered markup minus that final placeholder, and the markup we render gets the placeholder
  // back — otherwise a value ending in `<br>` would lose it on the first edit.
  const richFieldMarkup = value => {
    const html = richFieldHtml(value);
    return /<br\b[^>]*>\s*$/i.test(html) ? `${html}<br>` : html;
  };

  // A field's own font, size and direction are the note type's settings for that field, so the field states them
  // after the card shell — the same order the shell itself uses over the card's own styling. A font name is the one
  // value that reaches a stylesheet, so it is reduced to the characters a font family can be written with.
  const fieldRule = ({ font, size, rtl } = {}) => [
    font ? `font-family: ${String(font).replace(/[^\w\s,'-]/g, '')};` : '',
    Number(size) > 0 ? `font-size: ${Number(size)}px;` : '',
    rtl ? 'direction: rtl; text-align: right;' : '',
  ].filter(Boolean).join(' ');

  // A field's document: the note type's styling, then the app's own surface over it, then the field's own rule.
  const editorDocument = ({ html, styling, field }) => {
    const own = fieldRule(field);
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${String(styling || '').replace(/<\/style/gi, '<\\/style')}
${cardShell({ background: 'transparent', padding: '8px 9px' })}${own ? `\nbody.card { ${own} }` : ''}</style></head>
<body class="card">${richFieldMarkup(html)}</body></html>`;
  };

  // A card preview is a real card page: Anki renders a card inside a body carrying the `card` class, and that
  // page already carries jQuery, so the shell loads that library in the head — before the template's own
  // script, which is written against `$`.
  const previewDocument = ({ html, scriptSrc }) => `<!DOCTYPE html><html><head><meta charset="utf-8">
${previewKeyboardBridge}
<script src="${scriptSrc}"></script><style>
${cardShell({ background: themeToken('--paper', '#081426'), padding: '10px 12px', minHeight: 'min-height: 100%; ' })}
</style></head><body class="card">${String(html || '')}</body></html>`;

  return {
    editorDocument,
    fieldRule,
    previewDocument,
    previewKeyboardEventType,
    richFieldHtml,
    richFieldMarkup,
  };
});
