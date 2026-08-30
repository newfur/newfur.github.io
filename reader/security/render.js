export function setText(element, value) {
  element.textContent = String(value ?? '');
  return element;
}

export function clampProgress(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : 0;
}

export function createMermaidConfig(theme = 'default') {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'dark' ? 'dark' : 'default',
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
    state: { htmlLabels: false },
    mindmap: {
      useMaxWidth: false,
      nodeSpacing: 120,
      rankSpacing: 90,
      padding: 15,
    },
  };
}

export function sanitizeMermaidSource(source) {
  return String(source ?? '')
    .replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, '')
    .replace(/%%\{\s*(?:init|config)\s*:[\s\S]*?\}%%\s*/gi, '')
    .trim();
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeMarkdownDestination(value) {
  return String(value).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export function markdownLink(label, destination, security) {
  const safeUrl = security.sanitizeUrl(decodeMarkdownDestination(destination), 'navigation');
  const safeLabel = escapeHtml(decodeMarkdownDestination(label));
  return safeUrl ? `<a href="${escapeHtml(safeUrl)}">${safeLabel}</a>` : safeLabel;
}

export function markdownImage(alt, destination, security) {
  const safeUrl = security.sanitizeUrl(decodeMarkdownDestination(destination), 'resource');
  const safeAlt = escapeHtml(decodeMarkdownDestination(alt));
  return safeUrl ? `<img src="${escapeHtml(safeUrl)}" alt="${safeAlt}" class="obsidian-image" loading="lazy">` : safeAlt;
}

export function highlightTextNodes(root, query, targetMatchIndex = 0) {
  const escapedQuery = String(query ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escapedQuery) return 0;
  const regex = new RegExp(escapedQuery, 'gi');
  const NodeCtor = root.ownerDocument.defaultView.Node;
  let matchCount = 0;

  const visit = (node) => {
    if (node.nodeType === NodeCtor.TEXT_NODE) {
      const text = node.nodeValue;
      const matches = [...text.matchAll(regex)];
      if (matches.length === 0) return;

      const wrapper = root.ownerDocument.createElement('span');
      wrapper.className = 'search-highlight-wrapper';
      let offset = 0;
      for (const match of matches) {
        wrapper.appendChild(root.ownerDocument.createTextNode(text.slice(offset, match.index)));
        const mark = root.ownerDocument.createElement('mark');
        mark.className = 'search-highlight';
        if (matchCount === targetMatchIndex) {
          mark.classList.add('target-match');
          mark.id = 'search-target-match';
        }
        mark.textContent = match[0];
        wrapper.appendChild(mark);
        offset = match.index + match[0].length;
        matchCount++;
      }
      wrapper.appendChild(root.ownerDocument.createTextNode(text.slice(offset)));
      node.parentNode.replaceChild(wrapper, node);
      return;
    }

    if (node.nodeType !== NodeCtor.ELEMENT_NODE) return;
    const tagName = node.tagName.toLowerCase();
    if (tagName === 'script' || tagName === 'style' || node.classList.contains('textLayer')) return;
    [...node.childNodes].forEach(visit);
  };

  visit(root);
  return matchCount;
}

export function insertChapterHtml(element, html, security) {
  element.innerHTML = security.sanitizeChapterHtml(html);
  return element;
}

export function appendBookCover(container, { title, coverUrl, className = 'book-cover' }, security) {
  const safeUrl = security.sanitizeUrl(coverUrl, 'resource');
  if (!safeUrl) return null;
  const image = container.ownerDocument.createElement('img');
  image.className = className;
  image.src = safeUrl;
  image.alt = String(title ?? '');
  container.appendChild(image);
  return image;
}

export function renderFolderCover(container, book, security) {
  const image = appendBookCover(container, {
    title: book.title,
    coverUrl: book.coverUrl,
    className: 'folder-cover-item',
  }, security);
  if (image) return image;

  const placeholder = container.ownerDocument.createElement('div');
  placeholder.className = 'folder-cover-placeholder';
  const format = container.ownerDocument.createElement('span');
  format.textContent = String(book.format ?? '').toUpperCase();
  placeholder.appendChild(format);
  container.appendChild(placeholder);
  return placeholder;
}

export function renderAiMarkdown(element, markdown, formatMarkdown, security) {
  element.innerHTML = security.sanitizeAiHtml(formatMarkdown(String(markdown ?? '')));
  return element;
}

export function renderMermaidSvg(element, svg, security) {
  element.innerHTML = security.sanitizeMermaidSvg(svg);
  return element;
}

export function renderMermaidFallback(element, source) {
  element.replaceChildren();
  const pre = element.ownerDocument.createElement('pre');
  pre.className = 'mermaid-fallback';
  const code = element.ownerDocument.createElement('code');
  code.textContent = String(source ?? '');
  pre.appendChild(code);
  element.appendChild(pre);
  return pre;
}

export function renderErrorMessage(element, prefix, error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  element.textContent = `${String(prefix ?? 'Error')}: ${message}`;
  return element;
}
