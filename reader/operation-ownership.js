export class OperationOwner {
  #generation = 0;
  #token = null;

  begin(bookId) {
    this.#token = Object.freeze({ generation: ++this.#generation, bookId });
    return this.#token;
  }

  invalidate() {
    this.#generation += 1;
    this.#token = null;
  }

  currentToken() {
    return this.#token;
  }

  isCurrent(token, bookId = token?.bookId) {
    return token?.generation === this.#generation && token.bookId === bookId;
  }
}

export async function finishTrackedResource({ url, activeResources, pending, isCurrent, revoke = value => URL.revokeObjectURL(value) }) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    const index = activeResources.indexOf(url);
    if (index < 0) return;
    activeResources.splice(index, 1);
    if (url?.startsWith('blob:')) revoke(url);
  };

  try {
    await pending;
  } finally {
    if (!isCurrent()) cleanup();
  }
  return isCurrent();
}

export async function buildOwnedSearchIndex(chapters, extractChapterText, isCurrent, onChapterError = null) {
  const chunks = [];
  const chapterTexts = [];

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    if (typeof chapter.getContent !== 'function') continue;
    try {
      const html = await chapter.getContent();
      if (!isCurrent()) return null;
      const { chapterText, plainText } = extractChapterText(html);
      chapterTexts.push({ chapterTitle: chapter.title, chapterIndex: i, text: chapterText });
      if (plainText.length <= 50) continue;
      const chunkTexts = [];
      let start = 0;
      while (start < plainText.length) {
        const end = Math.min(start + 800, plainText.length);
        chunkTexts.push(plainText.substring(start, end));
        if (end === plainText.length) break;
        start = end - 150;
      }
      chunkTexts.forEach((text, chunkIndex) => {
        chunks.push({ chapterTitle: chapter.title, chapterIndex: i, chunkIndex, text });
      });
    } catch (error) {
      if (!isCurrent()) return null;
      onChapterError?.(error, chapter, i);
    }
  }

  return isCurrent() ? { chunks, chapters: chapterTexts } : null;
}
