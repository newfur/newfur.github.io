const ALLOWED_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);/i;
const VALID_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;base64,[A-Za-z0-9+/]+={0,2}|;,[^\s\\<>]+|,[^\s\\<>]+)$/i;
const BLOB_URL = /^blob:(?:null|https?:\/\/[^/\s]+)\/[^\s/?#]+$/i;
const RESOURCE_ATTRIBUTES = new Set(['src', 'poster', 'cite', 'data']);
const SVG_RESOURCE_ATTRIBUTES = new Set(['href', 'xlink:href', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end']);
const SVG_PAINT_ATTRIBUTES = new Set(['fill', 'stroke']);
const SVG_SAFE_PAINT = /^(?:none|inherit|currentColor|context-fill|context-stroke|transparent|[a-z]+|#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|url\(#[\w:.-]+\))$/i;
const SVG_ATTRIBUTES = ['viewBox', 'preserveAspectRatio', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'd', 'points', 'transform', 'fill', 'stroke', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule', 'gradientUnits', 'offset', 'stop-color', 'stop-opacity', 'text-anchor', 'font-size', 'font-family', 'id', 'class'];
const FORBID_TAGS = ['audio', 'base', 'button', 'datalist', 'details', 'dialog', 'embed', 'fieldset', 'form', 'iframe', 'input', 'keygen', 'label', 'legend', 'meter', 'object', 'optgroup', 'option', 'output', 'picture', 'progress', 'script', 'select', 'source', 'style', 'summary', 'template', 'textarea', 'track', 'video', 'feimage'];
const FORBID_ATTRIBUTES = new Set(['xlink:href', 'srcset', 'imagesrcset', 'background', 'formaction', 'action', 'ping', 'poster', 'longdesc', 'lowsrc', 'dynsrc', 'usemap', 'profile', 'manifest', 'cite', 'data', 'content', 'http-equiv', 'itemprop', 'itemtype', 'itemid', 'itemref']);
const HTML_ATTRIBUTES = ['id', 'class', 'title', 'lang', 'dir', 'style', 'href', 'src', 'alt', 'width', 'height', 'colspan', 'rowspan', 'scope', 'headers', 'start', 'value', 'datetime', 'target', 'rel'];
const SAFE_CSS_PROPERTIES = new Set(['color', 'background-color', 'font-style', 'font-weight', 'font-size', 'font-family', 'text-align', 'text-decoration', 'text-indent', 'text-transform', 'line-height', 'letter-spacing', 'word-spacing', 'white-space', 'vertical-align', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border', 'border-color', 'border-style', 'border-width', 'border-top', 'border-right', 'border-bottom', 'border-left', 'width', 'height', 'max-width', 'display', 'float', 'clear', 'list-style-type']);

function normalizeCssEscapes(value) {
  return String(value || '').replace(/\\([0-9a-f]{1,6})\s?/gi, (_, code) => String.fromCodePoint(parseInt(code, 16))).replace(/\\(.)/g, '$1');
}

function isSafeBlob(url) {
  return BLOB_URL.test(String(url || '').trim());
}

function isSafeUrl(value, context, trustedResourceUrls) {
  const normalized = String(value || '').trim();
  if (!normalized || /[\u0000-\u001f\u007f\\\s]/.test(normalized)) return false;
  if (normalized === '#') return false;
  if (context === 'svg-reference') return /^#[-\w:.]+$/.test(normalized);
  if (context === 'resource' && VALID_DATA_IMAGE.test(normalized) && !/,(?:[^,]*:|[^,]*\/\/)/i.test(normalized)) return true;
  if (context === 'resource' && isSafeBlob(normalized)) return trustedResourceUrls.has(normalized);
  if (/^#[-\w:.]+$/.test(normalized)) return true;
  if (/^https?:\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      return !url.username && !url.password && /^https?:$/.test(url.protocol);
    } catch {
      return false;
    }
  }
  return /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(normalized);
}

function sanitizeStyle(value) {
  const css = String(value || '').trim();
  if (!css) return '';
  return css.split(';').flatMap((declaration) => {
    const normalized = normalizeCssEscapes(declaration);
    if (/\\|\/\*|\*\/|[{}]|@/i.test(declaration)) return [];
    if (!declaration.trim()) return [];
    const separator = declaration.indexOf(':');
    if (separator < 1) return [];
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const propertyValue = declaration.slice(separator + 1).trim();
    if (!SAFE_CSS_PROPERTIES.has(property) || !propertyValue || /(?:url\s*\(|image-set\s*\(|cross-fade\s*\(|element\s*\(|expression\s*\(|javascript\s*:|position\s*:|(?:inset|top|right|bottom|left|z-index|filter|content|behavior|cursor|opacity|animation|transition)\s*:)/i.test(`${property}: ${propertyValue}`)) return [];
    if (/^(?:color|background-color|border-color|border-top-color|border-right-color|border-bottom-color|border-left-color)$/.test(property) && !/^(?:[a-z]+|#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|transparent|currentColor|inherit|none)$/i.test(propertyValue)) return [];
    return [`${property}: ${propertyValue}`];
  }).filter(Boolean).join('; ');
}

function isSafeSvgPaint(value) {
  const normalized = normalizeCssEscapes(value).trim();
  return !String(value || '').includes('\\') && SVG_SAFE_PAINT.test(normalized);
}

function getUrlContext(node, name) {
  const isSvg = node.namespaceURI === 'http://www.w3.org/2000/svg';
  if (name === 'src') return !isSvg && /^img$/i.test(node.nodeName) ? 'resource' : null;
  if (name === 'href') {
    if (!isSvg && /^a$/i.test(node.nodeName)) return 'navigation';
    if (isSvg && /^(?:a|use|image)$/i.test(node.nodeName)) return 'svg-reference';
    return null;
  }
  if (SVG_RESOURCE_ATTRIBUTES.has(name) && isSvg) return 'svg-reference';
  return null;
}

export function createSanitizer(windowObject = typeof window !== 'undefined' ? window : undefined) {
  const DOMPurify = windowObject?.DOMPurify;
  if (!DOMPurify || typeof DOMPurify.sanitize !== 'function' || typeof windowObject?.DOMParser !== 'function') {
    throw new Error('DOMPurify must be loaded first on the supplied window object');
  }
  const trustedResourceUrls = new Set();

  const preprocess = (html) => {
    const document = new windowObject.DOMParser().parseFromString(String(html ?? ''), 'text/html');
    for (const element of [...document.body.querySelectorAll('*')]) {
      const name = element.nodeName.toLowerCase();
      if (FORBID_TAGS.includes(name) || /^(?:animate|set|foreignobject)$/i.test(name)) {
        element.remove();
        continue;
      }
      for (const attribute of [...element.attributes]) {
        const attributeName = attribute.name.toLowerCase();
        const value = attribute.value;
        const context = getUrlContext(element, attributeName);
        const unsafeSvgReference = SVG_RESOURCE_ATTRIBUTES.has(attributeName) && getUrlContext(element, attributeName) === 'svg-reference' && !isSafeUrl(value, 'svg-reference', trustedResourceUrls);
        const unsafeNavigation = (attributeName === 'href' || attributeName === 'src') && (!context || !isSafeUrl(value, context, trustedResourceUrls));
        const unsafeSvgPaint = SVG_PAINT_ATTRIBUTES.has(attributeName) && !isSafeSvgPaint(value);
        if (FORBID_ATTRIBUTES.has(attributeName) || attributeName.startsWith('on') || RESOURCE_ATTRIBUTES.has(attributeName) && !isSafeUrl(value, context, trustedResourceUrls) || unsafeNavigation || unsafeSvgReference || unsafeSvgPaint) {
          element.removeAttribute(attribute.name);
        } else if (attributeName === 'style') {
          const safeStyle = sanitizeStyle(value);
          if (safeStyle) element.setAttribute('style', safeStyle); else element.removeAttribute(attribute.name);
        }
      }
    }
    return document.body.innerHTML;
  };

  const sanitize = (html) => {
    const trustedBlobPattern = [...trustedResourceUrls].map((url) => url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const allowedUri = new RegExp(`^(?:https?:\\/\\/[^\\s<>"']+|mailto:[^\\s<>"']+|#[A-Za-z0-9._:-]+|data:image\\/(?:png|jpeg|gif|webp|svg\\+xml);[^\\s<>"']+${trustedBlobPattern ? `|${trustedBlobPattern}` : ''})$`, 'i');
    const preprocessed = preprocess(html);
    const clean = DOMPurify.sanitize(preprocessed, {
      ALLOW_UNKNOWN_PROTOCOLS: false,
      ALLOWED_URI_REGEXP: allowedUri,
      FORBID_TAGS,
      ADD_TAGS: ['svg', 'circle', 'path', 'line', 'polyline', 'rect', 'polygon', 'linearGradient', 'stop', 'text', 'image', 'use'],
      ALLOWED_ATTR: [...HTML_ATTRIBUTES, 'xmlns', ...SVG_ATTRIBUTES],
      RETURN_TRUSTED_TYPE: false,
    });
    const sourceRoot = new windowObject.DOMParser().parseFromString(preprocessed, 'text/html').body;
    const cleanDocument = new windowObject.DOMParser().parseFromString(clean, 'text/html');
    const allowedAttributes = new Set([...HTML_ATTRIBUTES, 'xmlns', ...SVG_ATTRIBUTES]);
    const restore = (source, target) => {
      if (source.nodeName !== target.nodeName) return;
      for (const attribute of [...source.attributes]) {
        if (allowedAttributes.has(attribute.name) && !['href', 'src'].includes(attribute.name.toLowerCase()) && !FORBID_ATTRIBUTES.has(attribute.name.toLowerCase())) target.setAttribute(attribute.name, attribute.value);
      }
      [...source.children].forEach((child, index) => {
        const targetChild = target.children[index];
        if (targetChild) restore(child, targetChild);
      });
    };
    restore(sourceRoot, cleanDocument.body);
    for (const element of cleanDocument.body.querySelectorAll('*')) {
      for (const attribute of [...element.attributes]) {
        if (!allowedAttributes.has(attribute.name) || FORBID_ATTRIBUTES.has(attribute.name.toLowerCase())) element.removeAttribute(attribute.name);
      }
    }
    return cleanDocument.body.innerHTML;
  };

  const normalizeExternalLinks = (rootOrHtml) => {
    const html = typeof rootOrHtml === 'string' ? sanitize(rootOrHtml) : rootOrHtml;
    const root = typeof html === 'string' ? new windowObject.DOMParser().parseFromString(html, 'text/html').body : html;
    for (const anchor of root.querySelectorAll('a[href]')) {
      if (/^https?:/i.test(anchor.getAttribute('href'))) {
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
      }
    }
    return typeof rootOrHtml === 'string' ? root.innerHTML : root;
  };

  const sanitizeHtml = (html) => normalizeExternalLinks(html);
  return {
    sanitizeChapterHtml: sanitizeHtml,
    sanitizeMarkdownHtml: sanitizeHtml,
    sanitizeAiHtml: sanitizeHtml,
    sanitizeUrl: (url, context = 'navigation') => isSafeUrl(url, context, trustedResourceUrls) ? String(url).trim() : null,
    trustResourceUrl: (url) => {
      const normalized = String(url || '').trim();
      if (!isSafeBlob(normalized)) return false;
      trustedResourceUrls.add(normalized);
      return true;
    },
    revokeResourceUrl: (url) => trustedResourceUrls.delete(String(url || '').trim()),
    normalizeExternalLinks,
  };
}

export const security = typeof window !== 'undefined' && window.DOMPurify ? createSanitizer(window) : undefined;
