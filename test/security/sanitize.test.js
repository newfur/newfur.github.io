import test from 'node:test';
import assert from 'node:assert/strict';
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
