const ALLOWED_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);/i;
const SAFE_URL = /^(?:https?:|mailto:|blob:|#)/i;
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'cite', 'data']);
const SAFE_STYLE = /^(?:(?:color|background-color|font|font-family|font-size|font-style|font-weight|line-height|text-align|text-decoration|white-space|margin|padding|width|max-width|height|max-height|display|vertical-align|border(?:-[a-z-]+)?|fill|stroke)\s*:\s*[^;{}]+;?\s*)+$/i;
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|blob):|#|data:image\/(?:png|jpeg|gif|webp|svg\+xml);)/i;

function isSafeUrl(value, attribute) {
  const normalized = String(value || '').trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) return false;
  if (attribute === 'src' && ALLOWED_DATA_IMAGE.test(normalized)) return true;
  if (attribute === 'src' && /^blob:/i.test(normalized)) return true;
  return SAFE_URL.test(normalized) && !/^data:/i.test(normalized);
}

function cssIsSafe(value) {
  const css = String(value || '').trim();
  return !css || SAFE_STYLE.test(css) && !/(?:expression\s*\(|javascript\s*:|@import|position\s*:\s*(?:fixed|sticky)|(?:behavior|binding)\s*:)/i.test(css);
}

export function createSanitizer(windowObject = typeof window !== 'undefined' ? window : undefined) {
  const DOMPurify = windowObject?.DOMPurify;
  if (!DOMPurify || typeof DOMPurify.sanitize !== 'function' || typeof DOMPurify.addHook !== 'function') {
    throw new Error('DOMPurify must be loaded first on the supplied window object');
  }

  const config = {
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP,
    FORBID_TAGS: ['base', 'embed', 'form', 'iframe', 'input', 'object', 'script', 'style', 'template'],
    FORBID_ATTR: ['action', 'formaction', 'xlink:href'],
    ADD_TAGS: ['svg', 'circle', 'path', 'line', 'polyline', 'rect', 'polygon'],
    ADD_ATTR: ['target', 'rel', 'viewBox', 'preserveAspectRatio'],
  };

  const beforeSanitizeAttributes = (node) => {
    for (const attribute of Array.from(node.attributes || [])) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith('on') || URL_ATTRIBUTES.has(name) && !isSafeUrl(value, name)) {
        node.removeAttribute(attribute.name);
      }
      if (name === 'style' && !cssIsSafe(value)) node.removeAttribute(attribute.name);
    }
  };
  const uponSanitizeElement = (node) => {
    if (/^(?:animate|set|foreignobject|script|style)$/i.test(node.nodeName)) node.remove();
  };
  const uponSanitizeAttribute = (node, data) => {
    const name = data.attrName?.toLowerCase();
    if (name === 'src' && isSafeUrl(data.attrValue, 'src')) {
      data.keepAttr = true;
    }
    if (name === 'target' || name === 'rel') data.keepAttr = true;
  };

  DOMPurify.removeHook?.('beforeSanitizeAttributes');
  DOMPurify.removeHook?.('uponSanitizeElement');
  DOMPurify.removeHook?.('uponSanitizeAttribute');
  DOMPurify.addHook('beforeSanitizeAttributes', beforeSanitizeAttributes);
  DOMPurify.addHook('uponSanitizeElement', uponSanitizeElement);
  DOMPurify.addHook('uponSanitizeAttribute', uponSanitizeAttribute);

  const sanitize = (html) => DOMPurify.sanitize(String(html ?? ''), {
    ...config,
    RETURN_TRUSTED_TYPE: false,
  });

  const normalizeExternalLinks = (rootOrHtml) => {
    const source = typeof rootOrHtml === 'string'
      ? new windowObject.DOMParser().parseFromString(String(rootOrHtml), 'text/html').body
      : null;
    const root = source ? new windowObject.DOMParser().parseFromString(sanitize(rootOrHtml), 'text/html').body : rootOrHtml;
    const sourceAnchors = source ? [...source.querySelectorAll('a[href]')] : [];
    let externalIndex = 0;
    for (const anchor of root.querySelectorAll('a[href]')) {
      if (/^https?:/i.test(anchor.getAttribute('href'))) {
        const sourceAnchor = sourceAnchors.filter((candidate) => /^https?:/i.test(candidate.getAttribute('href')))[externalIndex++];
        if (sourceAnchor?.getAttribute('target') === '_blank') anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
      }
    }
    return typeof rootOrHtml === 'string' ? root.innerHTML : root;
  };

  const sanitizeHtml = (html) => normalizeExternalLinks(sanitize(html));
  return {
    sanitizeChapterHtml: sanitizeHtml,
    sanitizeMarkdownHtml: sanitizeHtml,
    sanitizeAiHtml: sanitizeHtml,
    sanitizeUrl: (url, attribute = 'href') => isSafeUrl(url, attribute) ? String(url).trim() : null,
    normalizeExternalLinks,
  };
}

export const security = typeof window !== 'undefined' && window.DOMPurify
  ? createSanitizer(window)
  : undefined;
