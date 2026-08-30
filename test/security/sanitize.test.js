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
