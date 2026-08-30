const ALLOWED_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);/i;
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'cite', 'data', 'filter', 'marker-start', 'marker-mid', 'marker-end']);
const SAFE_STYLE = /^(?:(?:color|background-color|font|font-family|font-size|font-style|font-weight|line-height|text-align|text-decoration|white-space|margin|padding|width|max-width|height|max-height|display|vertical-align|border(?:-[a-z-]+)?|fill|stroke)\s*:\s*[^;{}]+;?\s*)+$/i;
const SVG_PRESENTATION_ATTRIBUTES = new Set(['viewbox', 'preserveaspectratio', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'd', 'points', 'transform', 'fill', 'stroke', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule', 'gradientunits', 'offset', 'stop-color', 'stop-opacity', 'text-anchor', 'font-size', 'font-family', 'id', 'class']);

function isSafeUrl(value, context = 'navigation') {
  const normalized = String(value || '').trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) return false;
  if (context === 'svg-reference') return /^#/.test(normalized);
  if (context === 'resource' && ALLOWED_DATA_IMAGE.test(normalized)) return true;
  if (context === 'resource' && /^blob:/i.test(normalized)) return true;
  return /^(?:https?:|mailto:|#)/i.test(normalized);
}

function cssIsSafe(value) {
  const css = String(value || '').trim();
  return !css || SAFE_STYLE.test(css) && !/(?:url\s*\(|expression\s*\(|javascript\s*:|@import|position\s*:\s*(?:fixed|sticky)|(?:behavior|binding)\s*:)/i.test(css);
}

export function createSanitizer(windowObject = typeof window !== 'undefined' ? window : undefined) {
  const DOMPurify = windowObject?.DOMPurify;
  if (!DOMPurify || typeof DOMPurify.sanitize !== 'function' || typeof DOMPurify.addHook !== 'function') {
    throw new Error('DOMPurify must be loaded first on the supplied window object');
  }

  const config = {
    ALLOW_UNKNOWN_PROTOCOLS: true,
    FORBID_TAGS: ['base', 'button', 'datalist', 'details', 'dialog', 'embed', 'fieldset', 'form', 'iframe', 'input', 'keygen', 'label', 'legend', 'meter', 'object', 'optgroup', 'option', 'output', 'progress', 'script', 'select', 'style', 'summary', 'template', 'textarea'],
    FORBID_ATTR: ['action', 'formaction', 'xlink:href'],
    ADD_TAGS: ['svg', 'circle', 'path', 'line', 'polyline', 'rect', 'polygon', 'linearGradient', 'stop', 'text', 'image', 'use'],
    ADD_ATTR: ['target', 'rel', 'viewBox', 'preserveAspectRatio', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'd', 'points', 'transform', 'fill', 'stroke', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule', 'gradientUnits', 'offset', 'stop-color', 'stop-opacity', 'text-anchor', 'font-size', 'font-family', 'id', 'class'],
    ALLOWED_ATTR: ['class', 'id', 'style', 'title', 'alt', 'href', 'src', 'target', 'rel', 'viewBox', 'preserveAspectRatio', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'd', 'points', 'transform', 'fill', 'stroke', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule', 'gradientUnits', 'offset', 'stop-color', 'stop-opacity', 'text-anchor', 'font-size', 'font-family'],
  };

  const beforeSanitizeAttributes = (node) => {
    for (const attribute of Array.from(node.attributes || [])) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      const context = name === 'src' ? 'resource' : ((name === 'href' || ['filter', 'marker-start', 'marker-mid', 'marker-end'].includes(name)) && /^(?:image|use|svg|circle|path|line|polyline|rect|polygon|text)$/i.test(node.nodeName) ? 'svg-reference' : 'navigation');
      const hasExternalCssReference = /url\s*\(/i.test(value);
      if (name.startsWith('on') || URL_ATTRIBUTES.has(name) && !isSafeUrl(value, context) || ['fill', 'stroke'].includes(name) && hasExternalCssReference) {
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
    const context = name === 'src' ? 'resource' : ((name === 'href' || ['filter', 'marker-start', 'marker-mid', 'marker-end'].includes(name)) && /^(?:image|use|svg|circle|path|line|polyline|rect|polygon|text)$/i.test(node.nodeName) ? 'svg-reference' : 'navigation');
    if ((name === 'src' || name === 'href') && isSafeUrl(data.attrValue, context)) {
      data.keepAttr = true;
    }
    if (SVG_PRESENTATION_ATTRIBUTES.has(name)) data.keepAttr = true;
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
    sanitizeUrl: (url, context = 'navigation') => isSafeUrl(url, context) ? String(url).trim() : null,
    normalizeExternalLinks,
  };
}

export const security = typeof window !== 'undefined' && window.DOMPurify
  ? createSanitizer(window)
  : undefined;
