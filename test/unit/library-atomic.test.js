import test from 'node:test';
import assert from 'node:assert/strict';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
import { BookLibrary } from '../../reader/library.js';

function installIndexedDB() {
  globalThis.indexedDB = new FDBFactory();
  globalThis.IDBKeyRange = FDBKeyRange;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { persist: async () => true } } });
  globalThis.File = class File extends Blob {
    constructor(parts, name, options = {}) {
      super(parts, options);
      this.name = name;
      this.lastModified = options.lastModified || Date.now();
    }
  };
}

function book(id = 'book-1') {
  return {
    id, title: 'Title', author: 'Author', format: 'txt', file: new Blob(['text']),
    progress: { percent: 1, chapterIndex: 2 }, bookmarks: [], notes: [],
    stats: { totalTime: 0, readingDays: {}, hourlyDist: {} },
  };
}

test('concurrent progress and stats updates preserve both fields', async () => {
  installIndexedDB();
  const library = new BookLibrary();
  await library.addBook(book());

  const [progress, stats] = await Promise.all([
    library.updateBook('book-1', draft => { draft.progress.percent = 50; return draft.progress; }),
    library.updateBook('book-1', draft => { draft.stats = { ...(draft.stats || {}), totalTime: 12 }; return draft.stats; }),
  ]);

  const stored = await library.getBook('book-1');
  assert.equal(stored.progress.percent, 50);
  assert.equal(stored.stats.totalTime, 12);
  assert.equal(progress.percent, 50);
  assert.equal(stats.totalTime, 12);
});

test('updateBook resolves after commit and rejects missing or async updaters cleanly', async () => {
  installIndexedDB();
  const library = new BookLibrary();
  await library.addBook(book());

  await assert.rejects(() => library.updateBook('missing', () => ({})), /Book not found: missing/);
  await assert.rejects(() => library.updateBook('book-1', async draft => draft), /synchronous/);
  assert.equal((await library.getBook('book-1')).progress.percent, 0);
});

test('an aborted update preserves the previous record', async () => {
  installIndexedDB();
  const library = new BookLibrary();
  await library.addBook(book());

  await assert.rejects(() => library.updateBook('book-1', draft => {
    draft.progress.percent = 99;
    throw new Error('updater failed');
  }), /updater failed/);
  assert.equal((await library.getBook('book-1')).progress.percent, 0);
});
