const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../../frontend/scripts/chat/markdown');

const anchor = (href, label) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;

test('escapes an answer body before it renders any markdown', () => {
  assert.equal(render('<b>hi</b> & <script>alert(1)</script>'),
    '<p>&lt;b&gt;hi&lt;/b&gt; &amp; &lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(render(''), '');
  assert.equal(render(null), '');
  assert.equal(render(undefined), '');
});

test('renders the inline emphasis an agent answer uses', () => {
  assert.equal(render('**bold** and *italic* and ~~gone~~ and `code`'),
    '<p><strong>bold</strong> and <em>italic</em> and <del>gone</del> and <code>code</code></p>');
  assert.equal(render('**`code`**'), '<p><strong><code>code</code></strong></p>');
  assert.equal(render('`**not bold**`'), '<p><code>**not bold**</code></p>');
  assert.equal(render('snake_case_name and 2 * 3 * 4'), '<p>snake_case_name and 2 * 3 * 4</p>');
});

test('only follows a link whose target is safe', () => {
  assert.equal(render('[docs](https://example.com/a?b=1&c=2)'),
    `<p>${anchor('https://example.com/a?b=1&amp;c=2', 'docs')}</p>`);
  assert.equal(render('see https://example.com/x.'),
    `<p>see ${anchor('https://example.com/x', 'https://example.com/x')}.</p>`);
  assert.equal(render('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
  assert.equal(render('[x](data:text/html,<b>x</b>)'), '<p>[x](data:text/html,&lt;b&gt;x&lt;/b&gt;)</p>');
});

test('renders headings, rules and paragraphs', () => {
  assert.equal(render('## Title'), '<h2>Title</h2>');
  assert.equal(render('###### Deep'), '<h6>Deep</h6>');
  assert.equal(render('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>');
  assert.equal(render('a\nb'), '<p>a<br>b</p>');
});

test('renders ordered, unordered and nested lists', () => {
  assert.equal(render('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(render('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
  assert.equal(render('- one\n  - one a\n- two'),
    '<ul><li>one<ul><li>one a</li></ul></li><li>two</li></ul>');
  assert.equal(render('- first line\n  wrapped'), '<ul><li>first line\nwrapped</li></ul>');
  assert.equal(render('- one\n\ntext after'), '<ul><li>one</li></ul><p>text after</p>');
});

test('renders a blockquote and a table', () => {
  assert.equal(render('> quoted\n> more'), '<blockquote><p>quoted<br>more</p></blockquote>');
  assert.equal(render('| a | b |\n| --- | ---: |\n| 1 | 2 |'),
    '<div class="md-table"><table><thead><tr><th>a</th><th class="md-right">b</th></tr></thead>'
    + '<tbody><tr><td>1</td><td class="md-right">2</td></tr></tbody></table></div>');
  assert.equal(render('| a | b |\n| nope |'), '<p>| a | b |<br>| nope |</p>');
});

test('renders fenced code verbatim, including a fence still being streamed', () => {
  assert.equal(render('```js\nconst a = 1;\n```'),
    '<pre class="md-code"><code>const a = 1;</code></pre>');
  assert.equal(render('```\n**not bold** <b>x</b>'),
    '<pre class="md-code"><code>**not bold** &lt;b&gt;x&lt;/b&gt;</code></pre>');
  assert.equal(render('before\n\n```\ncode\n```\n\nafter'),
    '<p>before</p><pre class="md-code"><code>code</code></pre><p>after</p>');
});
