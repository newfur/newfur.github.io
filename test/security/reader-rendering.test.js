import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { createSanitizer } from '../../reader/security/sanitize.js';
import {
  appendBookCover,
  clampProgress,
  createMermaidConfig,
  highlightTextNodes,
  insertChapterHtml,
  markdownImage,
  markdownLink,
  renderAiMarkdown,
  renderErrorMessage,
  renderFolderCover,
  renderMermaidFallback,
  renderMermaidSvg,
  sanitizeMermaidSource,
  setText,
} from '../../reader/security/render.js';

function makeDom() {
  const window = new JSDOM('<main id="root"></main>').window;
  window.DOMPurify = createDOMPurify(window);
  return {
    window,
    document: window.document,
    root: window.document.querySelector('#root'),
    security: createSanitizer(window),
  };
}

async function renderWithBundledMermaid(source) {
  const window = new JSDOM('<!doctype html><body></body>', {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  }).window;
  window.structuredClone = globalThis.structuredClone;
  window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 });
  window.SVGElement.prototype.getComputedTextLength = () => 50;
  window.eval(fs.readFileSync(new URL('../../reader/libs/mermaid.min.js', import.meta.url), 'utf8'));
  window.mermaid.initialize(createMermaidConfig('default'));
  return {
    window,
    result: await window.mermaid.render(`test-${Date.now()}-${Math.random().toString(36).slice(2)}`, sanitizeMermaidSource(source)),
  };
}

test('metadata helpers render title author folder and format as text', () => {
  const { document, root } = makeDom();
  for (const value of [
    '<img src=x onerror=alert(1)>',
    '" autofocus onfocus="alert(2)',
    '</span><script>alert(3)</script>',
    'EPUB<img src=x onerror=alert(4)>',
  ]) {
    const element = document.createElement('span');
    setText(element, value);
    root.append(element);
  }

  assert.equal(root.querySelectorAll('img, script').length, 0);
  assert.match(root.textContent, /onerror=alert\(1\)/);
  assert.match(root.textContent, /autofocus/);
  assert.match(root.textContent, /EPUB/);
});

test('cover helpers reject attribute escapes and untrusted URLs but allow trusted reader blobs', () => {
  const { document, root, security } = makeDom();
  const trustedBlob = 'blob:https://reader.example/cover-1';
  security.trustResourceUrl(trustedBlob);

  assert.equal(appendBookCover(root, { title: '" onerror="alert(1)', coverUrl: 'javascript:alert(2)' }, security), null);
  assert.equal(root.querySelector('img'), null);

  const image = appendBookCover(root, { title: '<img src=x>', coverUrl: trustedBlob }, security);
  assert.equal(image.getAttribute('src'), trustedBlob);
  assert.equal(image.getAttribute('alt'), '<img src=x>');
  assert.equal(image.hasAttribute('onerror'), false);

  const folder = document.createElement('div');
  root.append(folder);
  renderFolderCover(folder, { title: '</img><script>bad</script>', format: 'epub<svg/onload=bad>', coverUrl: 'https://safe.example/cover.png' }, security);
  assert.equal(folder.querySelector('img').src, 'https://safe.example/cover.png');
  assert.equal(folder.querySelector('img').alt, '</img><script>bad</script>');
  assert.equal(root.querySelectorAll('script, svg').length, 0);
});

test('progress values are finite rounded percentages clamped from zero to one hundred', () => {
  assert.equal(clampProgress(-20), 0);
  assert.equal(clampProgress(49.6), 50);
  assert.equal(clampProgress(800), 100);
  assert.equal(clampProgress('75.4'), 75);
  assert.equal(clampProgress('1e999'), 0);
  assert.equal(clampProgress('10%;background:url(javascript:bad)'), 0);
});

test('AI Markdown is sanitized on insertion while safe formatting and approved links survive', () => {
  const { root, security } = makeDom();
  const formatMarkdown = () => `
    <h2>Safe heading</h2><strong>bold</strong>
    <a id="safe" href="https://example.com/read">safe</a>
    <a id="bad" href="javascript:alert(1)">bad</a>
    <img id="remote" src="https://example.com/pixel.png" onerror="alert(2)">
    <img id="data" src="data:image/png;base64,AAAA">
    <script>alert(3)</script><div onclick="alert(4)">body</div>
  `;

  renderAiMarkdown(root, 'persisted or streamed AI text', formatMarkdown, security);

  assert.ok(root.querySelector('h2'));
  assert.ok(root.querySelector('strong'));
  assert.equal(root.querySelector('#safe').target, '_blank');
  assert.equal(root.querySelector('#safe').rel, 'noopener noreferrer');
  assert.equal(root.querySelector('#bad').hasAttribute('href'), false);
  assert.equal(root.querySelector('#remote').src, 'https://example.com/pixel.png');
  assert.equal(root.querySelector('#data').src, 'data:image/png;base64,AAAA');
  assert.equal(root.querySelectorAll('script, [onclick], [onerror]').length, 0);
});

test('Markdown destinations are validated before link and image HTML construction', () => {
  const { security } = makeDom();
  assert.equal(markdownLink('safe', 'https://example.com/a?x=1&y=2', security), '<a href="https://example.com/a?x=1&amp;y=2">safe</a>');
  assert.equal(markdownLink('bad', 'javascript:alert(1)', security), 'bad');
  assert.equal(markdownImage('cover', 'data:image/png;base64,AAAA', security), '<img src="data:image/png;base64,AAAA" alt="cover" class="obsidian-image" loading="lazy">');
  assert.equal(markdownImage('bad', 'data:text/html,evil', security), 'bad');
  assert.equal(markdownLink('<img src=x onerror="bad">', 'https://example.com', security), '<a href="https://example.com">&lt;img src=x onerror=&quot;bad&quot;&gt;</a>');
  assert.equal(markdownLink('<script>bad</script>', 'javascript:bad', security), '&lt;script&gt;bad&lt;/script&gt;');
  assert.equal(markdownImage('" onerror="bad"><img src=x>', 'data:image/png;base64,AAAA', security), '<img src="data:image/png;base64,AAAA" alt="&quot; onerror=&quot;bad&quot;&gt;&lt;img src=x&gt;" class="obsidian-image" loading="lazy">');
  assert.equal(markdownImage('<svg onload=bad>', 'data:text/html,evil', security), '&lt;svg onload=bad&gt;');
});

test('search highlighting constructs marks from text without reparsing sanitized content', () => {
  const { root } = makeDom();
  root.textContent = 'before <img src=x onerror=alert(1)> IMG after img';

  const count = highlightTextNodes(root, 'img', 1);

  assert.equal(count, 3);
  assert.equal(root.querySelectorAll('mark.search-highlight').length, 3);
  assert.deepEqual([...root.querySelectorAll('mark')].map((mark) => mark.textContent), ['img', 'IMG', 'img']);
  assert.equal(root.querySelector('#search-target-match').textContent, 'IMG');
  assert.ok(root.querySelector('#search-target-match').classList.contains('target-match'));
  assert.equal(root.querySelectorAll('img, [onerror]').length, 0);
  assert.equal(root.textContent, 'before <img src=x onerror=alert(1)> IMG after img');
});

test('final chapter insertion sanitizes parser and prefetched HTML again', () => {
  const { root, security } = makeDom();
  insertChapterHtml(root, '<h1>Chapter</h1><img src="data:image/png;base64,AAAA" onerror="alert(1)"><script>alert(2)</script>', security);
  assert.ok(root.querySelector('h1'));
  assert.ok(root.querySelector('img'));
  assert.equal(root.querySelectorAll('script, [onerror]').length, 0);
});

test('persisted AI history and summaries are re-sanitized every time they render', () => {
  const { document, root, security } = makeDom();
  const persisted = ['history<script>alert(1)</script>', 'summary<img src=x onerror=alert(2)>'];
  for (const value of persisted) {
    const bubble = document.createElement('div');
    renderAiMarkdown(bubble, value, (text) => `<p>${text}</p>`, security);
    root.append(bubble);
  }

  assert.equal(root.querySelectorAll('script, [onerror]').length, 0);
  assert.match(root.textContent, /history/);
  assert.match(root.textContent, /summary/);
});

test('Mermaid SVG sanitizer preserves static diagram structure and strips active content', () => {
  const { root, security } = makeDom();
  renderMermaidSvg(root, `
    <svg viewBox="0 0 100 40" aria-labelledby="title" role="graphics-document" style="max-width: 100%; font-family: Arial; background-image: url(https://evil.example/bg)">
      <title id="title">Diagram</title><desc>Safe graph</desc>
      <defs><marker id="arrow"><path d="M0 0L10 5L0 10z" /></marker></defs>
      <g class="nodes" transform="translate(2 3)"><text x="4" y="8"><tspan>Node</tspan></text></g>
      <path d="M0 0L20 20" marker-end="url(#arrow)" />
      <script>alert(1)</script><foreignObject><div>bad</div></foreignObject>
      <animate attributeName="x" /><set attributeName="fill" />
      <image href="https://evil.example/x" onload="alert(2)" />
      <use href="https://evil.example/sprite#x" />
    </svg>
  `, security);

  assert.ok(root.querySelector('svg g text tspan'));
  assert.ok(root.querySelector('defs marker path'));
  assert.match(root.querySelector('svg').getAttribute('style'), /max-width: 100%/);
  assert.match(root.querySelector('svg').getAttribute('style'), /font-family: Arial/);
  assert.equal(root.querySelector('path[marker-end]').getAttribute('marker-end'), 'url(#arrow)');
  assert.equal(root.querySelectorAll('script, foreignObject, animate, set, [onload]').length, 0);
  assert.doesNotMatch(root.innerHTML, /evil\.example/);
});

test('bundled Mermaid renders strict SVG labels that survive the Mermaid sanitizer', async () => {
  const { window, result } = await renderWithBundledMermaid('flowchart TD; A[Alpha] --> B[Beta]');
  window.DOMPurify = createDOMPurify(window);
  const security = createSanitizer(window);
  const container = window.document.createElement('div');

  renderMermaidSvg(container, result.svg, security);

  assert.match(container.textContent, /Alpha/);
  assert.match(container.textContent, /Beta/);
  assert.ok(container.querySelector('svg text'));
  assert.ok(container.querySelector('path, line, polyline'));
  assert.ok(container.querySelector('style'));
  assert.equal(container.querySelector('style').namespaceURI, 'http://www.w3.org/2000/svg');
  assert.match(container.querySelector('style').textContent, /#[\w-]+\s+\.node/);
  assert.equal(container.querySelectorAll('foreignObject, script, [onload], [onclick]').length, 0);
  assert.doesNotMatch(container.querySelector('style').textContent, /https?:|javascript:|data:text|@import|url\s*\(/i);
  assert.equal(container.querySelectorAll('[href^="http"], [href^="javascript:"], [src]').length, 0);
});

test('Mermaid source cannot override strict SVG labels or inject active CSS', async () => {
  const hostile = `%%{init: { "securityLevel": "loose", "flowchart": { "htmlLabels": true } }}%%
flowchart TD
A[Alpha] --> B[Beta]
classDef hostile fill:red,background-image:url(https://evil.example/x),content:"bad";
class A hostile;`;
  const prepared = sanitizeMermaidSource(hostile);
  assert.doesNotMatch(prepared, /%%\{(?:init|config)/i);

  const parsableHostile = hostile.replace('background-image:url(https://evil.example/x),content:"bad"', 'background-image:evil,font-family:javascript:bad,content:bad');
  const { window, result } = await renderWithBundledMermaid(parsableHostile);
  window.DOMPurify = createDOMPurify(window);
  const security = createSanitizer(window);
  const container = window.document.createElement('div');
  renderMermaidSvg(container, result.svg, security);

  assert.match(container.textContent, /Alpha/);
  assert.equal(container.querySelectorAll('foreignObject').length, 0);
  assert.doesNotMatch(container.innerHTML, /evil\.example|url\s*\(\s*(?!#)|@import|expression|content\s*:/i);
});

test('Mermaid CSS sanitizer keeps scoped presentation and drops unsafe or global rules', () => {
  const { root, security } = makeDom();
  renderMermaidSvg(root, `<svg id="diagram-safe" xmlns="http://www.w3.org/2000/svg">
    <style>
      #diagram-safe .node { fill: red; stroke: #333 !important; }
      body, #diagram-safe .global { fill: black; }
      #diagram-safe .external { fill: url(https://evil.example/fill); content: "bad"; }
      @import url(https://evil.example/style.css);
    </style>
    <g class="node"><text>Safe</text><path d="M0 0L10 10" /></g>
  </svg>`, security);

  const css = root.querySelector('style').textContent;
  assert.match(css, /#diagram-safe \.node\{fill:red;stroke:#333\}/);
  assert.doesNotMatch(css, /body|global|external|evil\.example|url\s*\(|content|@import|!important/i);
});

test('Mermaid fallback and exception errors always render as text', () => {
  const { root } = makeDom();
  renderMermaidFallback(root, 'graph TD\nA[<img src=x onerror=alert(1)>]');
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.match(root.querySelector('code').textContent, /<img src=x/);

  renderErrorMessage(root, 'Error', new Error('</span><script>alert(2)</script>'));
  assert.equal(root.querySelectorAll('script').length, 0);
  assert.equal(root.textContent, 'Error: </span><script>alert(2)</script>');
});

test('offline artifacts include security render modules before the reader controller', () => {
  for (const output of ['../../index.html', '../../reader_offline.html']) {
    const html = fs.readFileSync(new URL(output, import.meta.url), 'utf8');
    const sanitizer = html.indexOf('// Module: reader/security/sanitize.js');
    const renderer = html.indexOf('// Module: reader/security/render.js');
    const reader = html.indexOf('// Module: reader/reader.js');
    assert.ok(sanitizer >= 0, `${output} includes sanitizer`);
    assert.ok(renderer > sanitizer, `${output} includes renderer after sanitizer`);
    assert.ok(reader > renderer, `${output} includes reader after renderer`);
  }
});
