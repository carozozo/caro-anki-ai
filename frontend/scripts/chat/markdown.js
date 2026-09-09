/**
 * Caro Anki markdown — the one renderer an agent answer body goes through.
 *
 * The agent writes in markdown (lists, bold, code, tables), so the conversation renders that subset
 * instead of showing the raw source. It is deliberately not a general markdown library: no dependency,
 * no raw-HTML pass-through, and no tag an answer could use to escape its own bubble — every character is
 * escaped first, so the only markup in the output is the markup this file builds, and a link survives
 * only when its target is http, https or mailto.
 *
 * Supported: fenced and inline code, headings, bold / italic / strikethrough, links and autolinks,
 * ordered and unordered lists (nested by indentation), blockquotes, tables, horizontal rules, paragraphs.
 *
 * Pure: `render(text)` -> HTML string, no DOM and no state between calls (or `module.exports` under Node).
 */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaroMarkdown = api;
})(globalThis, () => {
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const MARK = '\u0000';
  const PLACEHOLDER = /\u0000(\d+)\u0000/g;
  // A link is only followed when it can be: a javascript: or data: target renders as plain text.
  const SAFE_URL = /^(?:https?:\/\/|mailto:|#)/i;
  const FENCE = /^ {0,3}```\s*[\w+#.-]*\s*$/;
  const FENCE_END = /^ {0,3}```\s*$/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
  const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^ {0,3}>\s?/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const ROW = /^ {0,3}\|.*\|\s*$/;
  const DIVIDER = /^:?-+:?$/;
  const CODE_SPAN = /`([^`\n]+)`/g;
  const IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  const LINK = /\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  const AUTOLINK = /(^|[\s(])(https?:\/\/[^\s<>()]+)/g;
  const STRIKE = /~~(?=\S)([\s\S]*?\S)~~/g;
  const BOLD = /\*\*(?=\S)([\s\S]*?\S)\*\*/g;
  const BOLD_LOW = /__(?=\S)([\s\S]*?\S)__/g;
  const ITALIC = /\*(?=\S)([^*\n]*?\S)\*/g;
  // The underscore form must not sit inside a word, or an identifier like `snake_case_name` loses a piece.
  const ITALIC_LOW = /(?<!\w)_(?=\S)([^_\n]*?\S)_(?!\w)/g;

  const render = source => {
    // Fragments that must not be touched again (code, links) travel as placeholders and are only put
    // back once the whole block tree is built, so nothing in between can re-parse or escape them.
    const stash = [];
    const keep = html => `${MARK}${stash.push(html) - 1}${MARK}`;
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
    const anchor = (href, label) =>
      `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;

    const inline = raw => escape(raw)
      .replace(CODE_SPAN, (match, code) => keep(`<code>${code}</code>`))
      .replace(IMAGE, (match, alt, url) => (SAFE_URL.test(url) ? keep(anchor(url, alt || url)) : match))
      .replace(LINK, (match, label, url) => (SAFE_URL.test(url) ? keep(anchor(url, label || url)) : match))
      .replace(AUTOLINK, (match, prefix, url) => {
        const trailing = /[.,;:!?]+$/.exec(url)?.[0] || '';
        const href = url.slice(0, url.length - trailing.length);
        return `${prefix}${keep(anchor(href, href))}${trailing}`;
      })
      .replace(STRIKE, '<del>$1</del>')
      .replace(BOLD, '<strong>$1</strong>')
      .replace(BOLD_LOW, '<strong>$1</strong>')
      .replace(ITALIC, '<em>$1</em>')
      .replace(ITALIC_LOW, '<em>$1</em>');

    const cellsOf = line =>
      line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());

    // A table exists only when its divider row agrees with the header row; anything else is a paragraph
    // that happens to contain pipes — which is why both the block scanner and the line tests ask here.
    const tableHead = (lines, from) => {
      if (!ROW.test(lines[from]) || !ROW.test(lines[from + 1] ?? '')) return null;
      const header = cellsOf(lines[from]);
      const divider = cellsOf(lines[from + 1]);
      if (divider.length !== header.length || !divider.every(cell => DIVIDER.test(cell))) return null;
      return { header, divider };
    };
    const isBlockStart = (lines, index) => {
      const line = lines[index];
      return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)
        || ITEM.test(line) || Boolean(tableHead(lines, index));
    };
    const tableAt = (lines, from) => {
      const match = tableHead(lines, from);
      if (!match) return null;
      const { header, divider } = match;
      const align = divider.map(cell =>
        (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : ''));
      const style = column => (align[column] ? ` class="md-${align[column]}"` : '');
      let i = from + 2;
      const rows = [];
      while (i < lines.length && ROW.test(lines[i])) rows.push(cellsOf(lines[i++]));
      const head = header.map((cell, column) => `<th${style(column)}>${inline(cell)}</th>`).join('');
      const body = rows.map(row => `<tr>${header
        .map((_, column) => `<td${style(column)}>${inline(row[column] ?? '')}</td>`).join('')}</tr>`).join('');
      return {
        html: `<div class="md-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
        next: i,
      };
    };

    const listAt = (lines, from) => {
      const start = ITEM.exec(lines[from]);
      const ordered = /^\d/.test(start[2]);
      const indent = start[1].length;
      const items = [];
      let i = from;
      while (i < lines.length) {
        const match = ITEM.exec(lines[i]);
        if (match && match[1].length === indent) {
          items.push({ text: match[3], nested: '' });
          i += 1;
          continue;
        }
        // A deeper marker opens a list of its own inside the item it was written under.
        if (match && match[1].length > indent && items.length) {
          const nested = listAt(lines, i);
          items[items.length - 1].nested += nested.html;
          i = nested.next;
          continue;
        }
        if (match || !items.length) break;
        if (!lines[i].trim()) {
          // A blank line only continues the list when the next one is still part of it.
          if (!ITEM.test(lines[i + 1] ?? '') && !/^ {2,}\S/.test(lines[i + 1] ?? '')) break;
          i += 1;
          continue;
        }
        if (/^ {2,}\S/.test(lines[i])) {
          items[items.length - 1].text += `\n${lines[i].trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const html = `<${tag}>${items.map(item => `<li>${inline(item.text)}${item.nested}</li>`).join('')}</${tag}>`;
      return { html, next: i };
    };

    const renderLines = lines => {
      const html = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i += 1; continue; }
        if (FENCE.test(line)) {
          const code = [];
          i += 1;
          while (i < lines.length && !FENCE_END.test(lines[i])) code.push(lines[i++]);
          i += 1;                       // the closing fence, or the end of a reply still being written
          html.push(`<pre class="md-code"><code>${escape(code.join('\n'))}</code></pre>`);
          continue;
        }
        const heading = HEADING.exec(line);
        if (heading) {
          const level = heading[1].length;
          html.push(`<h${level}>${inline(heading[2].replace(/\s+#+\s*$/, ''))}</h${level}>`);
          i += 1;
          continue;
        }
        if (RULE.test(line)) { html.push('<hr>'); i += 1; continue; }
        if (QUOTE.test(line)) {
          const quoted = [];
          while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE, ''));
          html.push(`<blockquote>${renderLines(quoted)}</blockquote>`);
          continue;
        }
        const table = tableAt(lines, i);
        if (table) { html.push(table.html); i = table.next; continue; }
        if (ITEM.test(line)) {
          const list = listAt(lines, i);
          html.push(list.html);
          i = list.next;
          continue;
        }
        const paragraph = [line.trim()];
        i += 1;
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) paragraph.push(lines[i++].trim());
        html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
      }
      return html.join('');
    };

    return renderLines(String(source ?? '').replace(/\r\n?/g, '\n').split('\n'))
      .replace(PLACEHOLDER, (match, index) => stash[Number(index)] ?? '');
  };

  return { render };
});
