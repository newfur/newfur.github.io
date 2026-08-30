import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { createSanitizer } from '../../reader/security/sanitize.js';

test('chapter sanitizer removes executable markup', () => {
  const window = new JSDOM('').window;
  window.DOMPurify = createDOMPurify(window);
  const security = createSanitizer(window);
  const html = security.sanitizeChapterHtml(
    '<img src=x onerror="alert(1)"><script>alert(2)</script>',
  );

  assert.doesNotMatch(html, /onerror|script/i);
});

function makeSecurity() {
  const window = new JSDOM('').window;
  window.DOMPurify = createDOMPurify(window);
  return { window, security: createSanitizer(window) };
}

test('removes active elements and event handlers while preserving book structure', () => {
  const { security } = makeSecurity();
  const html = security.sanitizeChapterHtml(`
    <table><tr><td><strong>Chapter</strong><em> text</em></td></tr></table>
    <form><input value="secret"></form>
    <iframe src="https://example.com"></iframe><object data="x"></object><embed src="x">
    <svg><foreignObject><div>bad</div></foreignObject><animate attributeName="x" /></svg>
    <div onclick="alert(1)">safe</div>
  `);

  assert.match(html, /<table>|<strong>Chapter<\/strong>|<em> text<\/em>/);
  assert.doesNotMatch(html, /form|input|iframe|object|embed|foreignObject|animate|onclick/i);
});

test('allows approved links and image sources but rejects executable URLs', () => {
  const { security } = makeSecurity();
  security.trustResourceUrl('blob:https://example.com/id');
  const html = security.sanitizeChapterHtml(`
    <a href="#chapter-2">internal</a>
    <a href="https://example.com">https</a>
    <a href="http://example.com">http</a>
    <a href="mailto:reader@example.com">mail</a>
    <a href="javascript:alert(1)">js</a>
    <a href="data:text/html,<script>alert(1)</script>">html</a>
    <a href="//example.com">scheme relative</a>
    <img src="blob:https://example.com/id">
    <img src="data:image/png;base64,AAAA"><img src="data:image/jpeg;base64,AAAA">
    <img src="data:image/gif;base64,AAAA"><img src="data:image/webp;base64,AAAA">
    <img src="data:image/svg+xml;base64,AAAA"><img src="data:text/html,not-an-image">
    <div style="color: red; font-weight: bold">styled</div>
  `);

  assert.match(html, /href="#chapter-2"/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /href="http:\/\/example.com"/);
  assert.match(html, /href="mailto:reader@example.com"/);
  assert.match(html, /blob:https:\/\/example.com\/id/);
  assert.match(html, /data:image\/(png|jpeg|gif|webp|svg\+xml)/);
  assert.doesNotMatch(html, /javascript:|data:text\/html|href="\/\/|data:text\/html/);
  assert.match(html, /style="color: red; font-weight: bold"/);
});

test('normalizes approved external anchors with safe target rel values', () => {
  const { security } = makeSecurity();
  const html = security.normalizeExternalLinks(
    '<a href="https://example.com" target="_blank">link</a><a href="#local" target="_blank">local</a>',
  );

  assert.match(html, /href="https:\/\/example.com"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /href="#local"[^>]*rel=/);
});

test('removes unsafe CSS while retaining safe inline styles', () => {
  const { security } = makeSecurity();
  const html = security.sanitizeChapterHtml(`
    <p style="color: red; margin: 1em">safe</p>
    <p style="width: expression(alert(1));">expression</p>
    <p style="background: url(javascript:alert(1))">javascript url</p>
    <p style="@import url(https://evil.example/style.css)">import</p>
    <p style="position: fixed; top: 0">escape</p>
    <style>@import url(https://evil.example/style.css); body { color: red }</style>
  `);

  assert.match(html, /style="color: red; margin: 1em"/);
  assert.doesNotMatch(html, /style="[^"]*(?:expression|javascript:|@import|position\s*:\s*(?:fixed|sticky)|evil\.example)/i);
});

test('sanitizer requires a browser DOMPurify instance', () => {
  assert.throws(() => createSanitizer({}), /DOMPurify must be loaded first/);
});

test('removes every form and interactive control element', () => {
  const { security } = makeSecurity();
  const html = security.sanitizeChapterHtml(
    '<form><button>button</button><textarea>text</textarea><select><option>one</option><optgroup><option>two</option></optgroup></select><label>label</label><fieldset><legend>legend</legend><output>out</output><progress></progress><meter></meter></fieldset><datalist><option>three</option></datalist><details><summary>summary</summary>details</details><dialog>dialog</dialog><keygen></form>',
  );
  for (const tag of ['form', 'button', 'textarea', 'select', 'option', 'optgroup', 'label', 'fieldset', 'legend', 'output', 'progress', 'meter', 'datalist', 'details', 'summary', 'dialog', 'keygen']) {
    assert.doesNotMatch(html, new RegExp(`<${tag}\\b`, 'i'), `removed ${tag}`);
  }
});

test('preserves safe SVG geometry but removes external references and active behavior', () => {
  const { security } = makeSecurity();
  const html = security.sanitizeChapterHtml(`
    <svg viewBox="0 0 10 10" preserveAspectRatio="xMidYMid meet" id="icon" class="safe">
      <circle cx="5" cy="5" r="4" fill="red" stroke="black" opacity=".8" />
      <path d="M0 0L10 10" transform="translate(1 1)" />
      <rect x="1" y="2" width="3" height="4" rx="1" ry="2" />
      <line x1="0" y1="0" x2="10" y2="10" />
      <polygon points="0,0 1,1 2,0" />
      <linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="red" stop-opacity=".5" /></linearGradient>
      <text x="1" y="2" text-anchor="middle" font-size="10" font-family="serif">safe</text>
      <image href="https://evil.example/x" />
      <use href="https://evil.example/symbol" xlink:href="https://evil.example/x" />
      <use href="#safe-symbol" />
    </svg>
  `);
  for (const attribute of ['viewBox', 'preserveAspectRatio', 'cx', 'cy', 'r', 'd', 'transform', 'fill', 'stroke', 'opacity', 'gradientUnits', 'offset', 'stop-color', 'stop-opacity', 'text-anchor', 'font-size', 'font-family', 'id', 'class']) {
    assert.match(html, new RegExp(`${attribute}=`, 'i'), `preserved ${attribute}`);
  }
  assert.doesNotMatch(html, /evil\.example|href="https?:/i);
  assert.match(html, /href="#safe-symbol"/i);
});

test('rejects CSS resource URLs and preserves safe presentation styles', () => {
  const { security } = makeSecurity();
  const html = security.sanitizeChapterHtml(`
    <svg><circle fill="url(https://evil.example/fill)" stroke="url(#safe)" /></svg>
    <div style="color: red; border: 1px solid red">safe</div>
    <div style="fill: url(https://evil.example/fill)">fill</div>
    <div style="border-image: url(https://evil.example/border)">border</div>
  `);
  assert.match(html, /style="color: red; border: 1px solid red"/);
  assert.doesNotMatch(html, /url\s*\(\s*https?:/i);
});

test('validates navigation and resource URLs by context', () => {
  const { security } = makeSecurity();
  const trustedBlob = 'blob:https://example.com/reader-image-1';
  security.trustResourceUrl(trustedBlob);
  assert.equal(security.sanitizeUrl('https://example.com', 'navigation'), 'https://example.com');
  assert.equal(security.sanitizeUrl('mailto:reader@example.com', 'navigation'), 'mailto:reader@example.com');
  assert.equal(security.sanitizeUrl('#chapter', 'navigation'), '#chapter');
  assert.equal(security.sanitizeUrl('blob:https://example.com/id', 'navigation'), null);
  assert.equal(security.sanitizeUrl('data:image/png;base64,AAAA', 'resource'), 'data:image/png;base64,AAAA');
  assert.equal(security.sanitizeUrl('data:image/jpeg;base64,AAAA', 'resource'), 'data:image/jpeg;base64,AAAA');
  assert.equal(security.sanitizeUrl('data:image/gif;base64,AAAA', 'resource'), 'data:image/gif;base64,AAAA');
  assert.equal(security.sanitizeUrl('data:image/webp;base64,AAAA', 'resource'), 'data:image/webp;base64,AAAA');
  assert.equal(security.sanitizeUrl('data:image/svg+xml;base64,AAAA', 'resource'), 'data:image/svg+xml;base64,AAAA');
  assert.equal(security.sanitizeUrl(trustedBlob, 'resource'), trustedBlob);
  assert.equal(security.sanitizeUrl('blob:https://example.com/id', 'resource'), null);
  assert.equal(security.sanitizeUrl('blob:null/offline-image', 'resource'), null);
  assert.equal(security.sanitizeUrl('blob:javascript:alert(1)', 'resource'), null);
  assert.equal(security.sanitizeUrl('blob:https://example.com/', 'resource'), null);
  const offlineBlob = 'blob:null/offline-image';
  assert.equal(security.trustResourceUrl(offlineBlob), true);
  assert.equal(security.sanitizeUrl(offlineBlob, 'resource'), offlineBlob);
  security.revokeResourceUrl(trustedBlob);
  assert.equal(security.sanitizeUrl(trustedBlob, 'resource'), null);
  assert.equal(security.sanitizeUrl('data:text/html,evil', 'resource'), null);
  assert.equal(security.sanitizeUrl('//example.com', 'navigation'), null);
});

test('rejects SVG resource sources and CSS reference bypasses', () => {
  const { security } = makeSecurity();
  const html = security.sanitizeChapterHtml(`
    <svg>
      <image src="https://evil.example/src" href="https://evil.example/href" xlink:href="data:image/png;base64,AAAA" />
      <use href="#safe" xlink:href="https://evil.example/x" />
      <circle clip-path="url(https://evil.example/clip)" mask="url(#mask)" filter="url(https://evil.example/filter)" marker-start="url(https://evil.example/marker)" fill="url(https://evil.example/fill)" stroke="url(#safe)" />
      <style>.x { fill: u\\72l(https://evil.example/fill) }</style>
    </svg>
    <div style="color: red">safe</div>
    <div style="background: u\\72l(https://evil.example/bg)">escaped</div>
    <div style="width: e\\78pression(alert(1))">expression</div>
    <div style="background: java\\73cript:alert(1)">javascript</div>
    <div style="\\40import url(https://evil.example/css)">import</div>
  `);
  assert.doesNotMatch(html, /evil\.example|data:image\/png|url\s*\(https?:|style="[^"]*(?:e\\?xpression|java\\?script|@import)/i);
  assert.match(html, /color: red/);
  assert.match(html, /href="#safe"/);
});

test('rejects escaped SVG paint and resource references while preserving safe values', () => {
  const { security } = makeSecurity();
  const html = security.sanitizeChapterHtml(`
    <svg>
      <circle fill="red" stroke="currentColor" />
      <path fill="url(#safe-paint)" stroke="url(#safe-stroke)" />
      <circle fill="u\\72l(https://evil.example/fill)" />
      <circle stroke="u\\72l(https://evil.example/stroke)" />
      <circle clip-path="u\\72l(https://evil.example/clip)" mask="u\\72l(https://evil.example/mask)" filter="u\\72l(https://evil.example/filter)" marker-start="u\\72l(https://evil.example/marker)" />
    </svg>
  `);
  assert.match(html, /fill="red"/);
  assert.match(html, /stroke="currentColor"/);
  assert.match(html, /url\(#safe-paint\)/);
  assert.match(html, /url\(#safe-stroke\)/);
  assert.doesNotMatch(html, /evil\.example|u\\72l/i);
});

test('removes active media and fetch controls while retaining ordinary images', () => {
  const { security } = makeSecurity();
  const html = security.sanitizeChapterHtml(
    '<video src="https://evil.example/v"></video><audio src="https://evil.example/a"></audio><source src="https://evil.example/s"><track src="https://evil.example/t"><picture><source srcset="https://evil.example/p"><img src="data:image/png;base64,AAAA"></picture><img src="data:image/png;base64,AAAA">',
  );
  for (const tag of ['video', 'audio', 'source', 'track', 'picture']) {
    assert.doesNotMatch(html, new RegExp(`<${tag}\\b`, 'i'), `removed ${tag}`);
  }
  assert.match(html, /<img src="data:image\/png/);
});

test('all content helpers share the same sanitization boundary', () => {
  const { security } = makeSecurity();
  for (const helper of ['sanitizeChapterHtml', 'sanitizeMarkdownHtml', 'sanitizeAiHtml']) {
    assert.doesNotMatch(security[helper]('<script>alert(1)</script><p>safe</p>'), /script/i, helper);
    assert.match(security[helper]('<p>safe</p>'), /safe/);
  }
});

test('loads DOMPurify before the application module in source and offline output', () => {
  const readerHtml = fs.readFileSync(new URL('../../reader/reader.html', import.meta.url), 'utf8');
  assert.ok(readerHtml.indexOf('libs/dompurify.min.js') < readerHtml.indexOf('type="module" src="reader.js"'));
  for (const output of ['../../index.html', '../../reader_offline.html']) {
    const html = fs.readFileSync(new URL(output, import.meta.url), 'utf8');
    assert.ok(html.indexOf('DOMPurify') < html.indexOf('// Module: reader/i18n.js'), output);
  }
});

test('isolates trusted resources between sanitizers sharing one purifier', () => {
  const window = new JSDOM('').window;
  window.DOMPurify = createDOMPurify(window);
  const first = createSanitizer(window);
  const second = createSanitizer(window);
  const blob = 'blob:null/isolated-image';

  first.trustResourceUrl(blob);
  assert.equal(first.sanitizeUrl(blob, 'resource'), blob);
  assert.equal(second.sanitizeUrl(blob, 'resource'), null);
  assert.doesNotMatch(second.sanitizeChapterHtml(`<img src="${blob}">`), /blob:null/);
});

test('rejects hostile non-url SVG reference tokens while preserving safe paint values', () => {
  const { security } = makeSecurity();
  const html = security.sanitizeChapterHtml(`
    <svg>
      <circle fill="red" stroke="none" />
      <path fill="inherit" stroke="context-stroke" />
      <circle fill="javascript:alert(1)" stroke="data:text/html,evil" />
      <circle fill="evil-token" stroke="https:evil" clip-path="evil-token" mask="data:image/png;base64,AAAA" filter="javascript:bad" marker-start="https://evil.example/m" />
    </svg>
  `);
  assert.match(html, /fill="red"/);
  assert.match(html, /stroke="none"/);
  assert.match(html, /fill="inherit"/);
  assert.match(html, /stroke="context-stroke"/);
  assert.doesNotMatch(html, /javascript:|data:text|evil-token|https:evil|evil\.example/i);
});

test('normalizes mixed and duplicate external links after sanitization', () => {
  const { security } = makeSecurity();
  const html = security.normalizeExternalLinks(`
    <a href="javascript:bad">removed</a>
    <a href="https://one.example">one</a>
    <a href="https://one.example">duplicate</a>
    <a href="#local">local</a>
    <a href="mailto:reader@example.com">mail</a>
  `);
  assert.doesNotMatch(html, /javascript/);
  assert.equal((html.match(/rel="noopener noreferrer"/g) || []).length, 2);
  assert.match(html, /href="#local"/);
  assert.match(html, /href="mailto:reader@example.com"/);
});
