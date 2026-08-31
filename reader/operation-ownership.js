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

export class OwnedLease {
  constructor() {
    this.generation = 0;
    this.active = null;
  }

  acquire(ownerId) {
    this.active = Object.freeze({ generation: ++this.generation, ownerId });
    return this.active;
  }

  current() {
    return this.active;
  }

  isCurrent(lease) {
    return lease === this.active;
  }

  release(lease) {
    if (!this.isCurrent(lease)) return false;
    this.active = null;
    return true;
  }
}

export class OwnedValueLock {
  constructor(readValue, writeValue, lockedValue) {
    this.readValue = readValue;
    this.writeValue = writeValue;
    this.lockedValue = lockedValue;
    this.holders = new Set();
    this.originalValue = null;
  }

  acquire(ownerId) {
    if (this.holders.size === 0) {
      this.originalValue = this.readValue();
      this.writeValue(this.lockedValue);
    }
    const token = Object.freeze({ ownerId, lockId: Symbol(ownerId) });
    this.holders.add(token);
    return token;
  }

  release(token) {
    if (!this.holders.delete(token)) return false;
    if (this.holders.size === 0) {
      this.writeValue(this.originalValue);
      this.originalValue = null;
    }
    return true;
  }

  reset() {
    this.holders.clear();
    this.originalValue = null;
  }
}

export function ownedCallback(isCurrent, callback) {
  return (...args) => {
    if (isCurrent()) return callback(...args);
  };
}

export async function completeOwnedTransition({ pending, isCurrent, complete }) {
  await pending;
  if (!isCurrent()) return false;
  complete();
  return true;
}

export class OwnedDebouncer {
  constructor(schedule = setTimeout, cancel = clearTimeout) {
    this.scheduleTimer = schedule;
    this.cancelTimer = cancel;
    this.pending = null;
  }

  schedule({ token, bookId, update, isCurrent, persist, apply, onError = null, delay = 1000 }) {
    if (this.pending) this.cancelTimer(this.pending.timer);
    const request = { token, bookId, update: { ...update }, isCurrent, persist, apply, timer: null };
    request.timer = this.scheduleTimer(async () => {
      if (this.pending !== request) return;
      this.pending = null;
      if (!isCurrent(token, bookId)) return;
      try {
        await persist(bookId, request.update);
        if (isCurrent(token, bookId)) apply(request.update);
      } catch (error) {
        onError?.(error);
      }
    }, delay);
    this.pending = request;
  }

  cancel() {
    if (!this.pending) return;
    this.cancelTimer(this.pending.timer);
    this.pending = null;
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
