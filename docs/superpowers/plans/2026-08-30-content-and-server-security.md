# Content and Server Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent imported content, AI output, metadata, HTTP paths, extension requests, and WebSocket clients from crossing application trust boundaries.

**Architecture:** Add one DOMPurify-backed browser security module and route every untrusted HTML/URL path through it. Refactor the Node server into exported, testable path and WebSocket policy helpers, then add deployment headers and bounded service-worker caching.

**Tech Stack:** Browser ESM, DOMPurify, jsdom, Node `node:test`, `ws`, service workers.

---

### Task 1: Establish the security test harness

**Files:**
- Create: `reader/package.json`
- Create: `test/package.json`
- Create: `test/security/sanitize.test.js`
- Create: `test/security/server.test.js`
- Modify: `package.json`

- [ ] **Step 1: Define local ESM boundaries without converting CommonJS build scripts**

```json
// reader/package.json and test/package.json
{ "type": "module" }
```

The root package remains CommonJS, so `server.js` and `scratch/*.js` continue using `require()`. Browser source and tests become directly importable ESM.

- [ ] **Step 2: Add a failing sanitizer smoke test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { createSanitizer } from '../../reader/security/sanitize.js';

test('chapter sanitizer removes executable markup', () => {
  const window = new JSDOM('').window;
  window.DOMPurify = createDOMPurify(window);
  const security = createSanitizer(window);
  const html = security.sanitizeChapterHtml('<img src=x onerror="alert(1)"><script>alert(2)</script>');
  assert.doesNotMatch(html, /onerror|script/i);
});
```

- [ ] **Step 3: Run the test and verify the missing-module failure**

Run: `node --test test/security/sanitize.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `reader/security/sanitize.js`.

- [ ] **Step 4: Add scripts that include the existing regression test**

```json
"test": "npm run test:unit && npm run test:security && node scratch/test_tts_review_fixes.js",
"test:unit": "node --test test/unit/*.test.js",
"test:security": "node --test test/security/*.test.js"
```

- [ ] **Step 5: Commit the red test harness**

```sh
git add package.json reader/package.json test
git commit -m "test: add security regression harness"
```

### Task 2: Implement the common sanitization policy

**Files:**
- Create: `reader/security/sanitize.js`
- Modify: `reader/reader.html`
- Modify: `scratch/compile_offline.js`
- Test: `test/security/sanitize.test.js`

- [ ] **Step 1: Extend failing tests for URL, SVG, CSS, and safe formatting behavior**

```js
test('sanitizer keeps formatting but rejects active URLs and SVG', () => {
  const window = new JSDOM('').window;
  window.DOMPurify = createDOMPurify(window);
  const security = createSanitizer(window);
  const html = security.sanitizeChapterHtml(`
    <table><tr><td>kept</td></tr></table>
    <a href="javascript:alert(1)">bad</a>
    <svg><circle cx="1" cy="1" r="1"/><foreignObject>bad</foreignObject></svg>
  `);
  assert.match(html, /<table>/);
  assert.match(html, /<circle/);
  assert.doesNotMatch(html, /javascript:|foreignObject/i);
});
```

- [ ] **Step 2: Implement a factory so browser and jsdom use the same policy**

```js
const SAFE_PROTOCOL = /^(?:https?:|mailto:|blob:|data:image\/(?:png|gif|jpe?g|webp|svg\+xml);)/i;

export function createSanitizer(windowObject = window) {
  const purifier = windowObject.DOMPurify;
  if (!purifier) throw new Error('DOMPurify must be loaded before sanitize.js');
  purifier.addHook('uponSanitizeAttribute', (_node, data) => {
    if (/^on/i.test(data.attrName)) data.keepAttr = false;
    if (/^(?:href|src|xlink:href)$/i.test(data.attrName) &&
        data.attrValue && !data.attrValue.startsWith('#') &&
        !SAFE_PROTOCOL.test(data.attrValue)) data.keepAttr = false;
  });
  const sanitize = html => purifier.sanitize(String(html || ''), {
    USE_PROFILES: { html: true, svg: true, svgFilters: false },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button',
      'textarea', 'select', 'foreignObject', 'animate', 'set'],
    FORBID_ATTR: ['srcdoc']
  });
  return {
    sanitizeChapterHtml: sanitize,
    sanitizeMarkdownHtml: sanitize,
    sanitizeAiHtml: sanitize,
    sanitizeUrl(value) {
      const url = String(value || '').trim();
      return url.startsWith('#') || SAFE_PROTOCOL.test(url) ? url : null;
    }
  };
}

export const security = createSanitizer();
```

- [ ] **Step 3: Load DOMPurify before application modules in source and offline builds**

Add `node_modules/dompurify/dist/purify.min.js` as an inline script before `reader.js`; make `compile_offline.js` inline the same file rather than emit a runtime package path.

- [ ] **Step 4: Run tests**

Run: `node --test test/security/sanitize.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add reader/security/sanitize.js reader/reader.html scratch/compile_offline.js test/security/sanitize.test.js
git commit -m "feat: add shared content sanitization boundary"
```

### Task 3: Sanitize every parser result

**Files:**
- Modify: `reader/parsers/epub-parser.js:362-466`
- Modify: `reader/parsers/text-parser.js:150-313`
- Modify: `reader/parsers/azw3-parser.js`
- Test: `test/security/parsers.test.js`

- [ ] **Step 1: Add malicious EPUB, FB2, Markdown, and MOBI fixture assertions**

Each test must assert that final `getContent()` output contains safe text/table/image markup but no `script`, `on*`, `javascript:`, `foreignObject`, form, frame, or embed content. Add an FB2 malformed-XML assertion that rejects with `Invalid FB2 XML`.

- [ ] **Step 2: Verify tests fail against raw parser output**

Run: `node --test test/security/parsers.test.js`

Expected: FAIL because active attributes remain.

- [ ] **Step 3: Sanitize after all parser rewrites and before caching**

```js
import { security } from '../security/sanitize.js';

// EPUB final return
return security.sanitizeChapterHtml(
  this._cleanMalformedTagFragments(stylesHtml + body.innerHTML)
);
```

Use `security.sanitizeMarkdownHtml()` after Markdown compilation and `security.sanitizeChapterHtml()` on every MOBI/AZW3 chapter closure. Replace raw malformed-input fallback with an escaped error paragraph created through DOM text nodes.

- [ ] **Step 4: Run parser security tests**

Run: `node --test test/security/parsers.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add reader/parsers test/security/parsers.test.js
git commit -m "fix: sanitize imported book content"
```

### Task 4: Make reader and AI rendering defensive

**Files:**
- Modify: `reader/reader.js:2408-2780,3607-3652,6942-7026,8178-9113`
- Test: `test/security/reader-rendering.test.js`

- [ ] **Step 1: Add failing metadata and AI output tests**

Test title, author, folder, cover URL, AI Markdown links, summary history, Mermaid SVG, and Mermaid fallback with payloads containing attribute escapes, scripts, active SVG, and `javascript:`.

- [ ] **Step 2: Replace metadata interpolation with DOM properties**

```js
const title = document.createElement('h3');
title.className = 'book-title';
title.textContent = String(book.title || 'Untitled');
card.append(title);

const coverUrl = security.sanitizeUrl(book.cover);
if (coverUrl) coverImage.src = coverUrl;
coverImage.alt = String(book.title || '');
```

- [ ] **Step 3: Add the final chapter insertion defense and sanitize AI/Mermaid output**

```js
contentEl.innerHTML = security.sanitizeChapterHtml(rawHtml);
messageEl.innerHTML = security.sanitizeAiHtml(formatMarkdown(reply));
mermaidContainer.innerHTML = security.sanitizeAiHtml(svg);
fallbackCode.textContent = source;
```

Before insertion, validate generated links/images and add `target="_blank"` plus `rel="noopener noreferrer"` only to approved external links.

- [ ] **Step 4: Run tests and commit**

Run: `node --test test/security/reader-rendering.test.js`

Expected: PASS.

```sh
git add reader/reader.js test/security/reader-rendering.test.js
git commit -m "fix: secure reader and AI rendering"
```

### Task 5: Harden static routing and the TTS relay

**Files:**
- Modify: `server.js`
- Test: `test/security/server.test.js`

- [ ] **Step 1: Add failing traversal and relay-limit integration tests**

Cover `/reader/../server.js`, encoded dot segments and slashes, `.git/config`, invalid Origin, oversized payload, queue overflow, connection cap, and idle timeout. Assert default host is `127.0.0.1`.

- [ ] **Step 2: Export exact mount-containment helpers**

```js
function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveStaticPath(rawPathname) {
  const pathname = decodeURIComponent(rawPathname);
  const mount = STATIC_MOUNTS.find(({ prefix }) => pathname.startsWith(prefix));
  if (!mount) return null;
  const relative = pathname.slice(mount.prefix.length);
  const candidate = path.resolve(mount.root, relative);
  return isWithin(mount.root, candidate) ? candidate : null;
}
```

- [ ] **Step 3: Bound WebSocket capabilities**

Construct `WebSocket.Server` with `maxPayload`; validate path and Origin before proxy creation; track active connection count, queued message count/bytes, connection timeout, and idle timeout. Close with policy code `1008` or message-too-large code `1009` when a bound is exceeded.

- [ ] **Step 4: Listen on loopback by default and run tests**

```js
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST);
```

Run: `node --test test/security/server.test.js`

Expected: PASS, including original traversal PoC returning 403/404 rather than 200.

- [ ] **Step 5: Commit**

```sh
git add server.js test/security/server.test.js
git commit -m "fix: harden static server and TTS relay"
```

### Task 6: Add deployment headers and bounded cache ownership

**Files:**
- Modify: `server.js`
- Modify: `vercel.json`
- Modify: `sw.js`
- Modify: `service-worker.js`
- Test: `test/security/service-worker.test.js`

- [ ] **Step 1: Add failing header and cache lifecycle tests**

Assert CSP, `nosniff`, referrer, frame, and permissions policies exist; activation preserves unrelated caches; required precache failure rejects installation; background writes use `waitUntil`; API/cross-origin responses are excluded; runtime entries are bounded.

- [ ] **Step 2: Add matching HTTP/Vercel headers**

Use one reviewed CSP compatible with the now-local scripts. Set `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, and `frame-ancestors 'none'` in both deployment paths.

- [ ] **Step 3: Restrict service-worker cache ownership**

```js
const CACHE_PREFIX = 'raconteur-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}v2`;
// Activation deletes only names that start with CACHE_PREFIX and differ from CACHE_NAME.
```

Attach revalidation and cache writes to `event.waitUntil()`, restrict caching to approved same-origin GET assets, and evict oldest runtime entries above the configured maximum.

- [ ] **Step 4: Validate extension proxy destinations**

In `service-worker.js`, reject non-HTTP(S), loopback, link-local, and private-network destinations unless explicitly approved; validate `sender.id`, cap request body sizes, add fetch timeouts, and abort streams on port disconnect.

- [ ] **Step 5: Run and commit**

Run: `node --test test/security/service-worker.test.js`

Expected: PASS.

```sh
git add server.js vercel.json sw.js service-worker.js test/security/service-worker.test.js
git commit -m "fix: enforce deployment and cache security policies"
```
