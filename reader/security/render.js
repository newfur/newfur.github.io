export function setText(element, value) {
  element.textContent = String(value ?? '');
  return element;
}

export function clampProgress(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : 0;
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeMarkdownDestination(value) {
  return String(value).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export function markdownLink(label, destination, security) {
  const safeUrl = security.sanitizeUrl(decodeMarkdownDestination(destination), 'navigation');
  return safeUrl ? `<a href="${escapeAttribute(safeUrl)}">${label}</a>` : label;
}

export function markdownImage(alt, destination, security) {
  const safeUrl = security.sanitizeUrl(decodeMarkdownDestination(destination), 'resource');
  return safeUrl ? `<img src="${escapeAttribute(safeUrl)}" alt="${alt}" class="obsidian-image" loading="lazy">` : alt;
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
