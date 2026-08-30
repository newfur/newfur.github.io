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
    id, title: 'Title', author: 'Author', format: 'txt', file: new Blob(['text']), folder: 'Reading',
    progress: { percent: 1, chapterIndex: 2 }, bookmarks: [], notes: [], aiChats: [],
    stats: { totalTime: 0, readingDays: {}, hourlyDist: {} },
  };
}

test('concurrent public progress and stats updates preserve both fields', async () => {
  installIndexedDB();
  const library = new BookLibrary();
  await library.addBook(book());

  await Promise.all([
    library.updateProgress('book-1', { percent: 50 }),
    library.addReadingDuration('book-1', 12),
  ]);

  const stored = await library.getBook('book-1');
  assert.equal(stored.progress.percent, 50);
  assert.equal(stored.stats.totalTime, 12);
});

test('concurrent public annotation updates preserve notes, bookmarks, and chats', async () => {
  installIndexedDB();
  const library = new BookLibrary();
  await library.addBook(book());

  await Promise.all([
    library.saveNote('book-1', { noteId: 'note-1', text: 'note' }),
    library.saveBookmark('book-1', { chapterIndex: 1, elementIndex: 2, pdfPage: 3, title: 'bookmark' }),
    library.saveAIChat('book-1', { chatId: 'chat-1', query: 'q', reply: 'a' }),
  ]);

  const stored = await library.getBook('book-1');
  assert.deepEqual(stored.notes.map(note => note.noteId), ['note-1']);
  assert.equal(stored.bookmarks.length, 1);
  assert.deepEqual(stored.aiChats.map(chat => chat.chatId), ['chat-1']);
});

test('updateBook persists a synchronous returned record instead of the draft', async () => {
  installIndexedDB();
  const library = new BookLibrary();
  await library.addBook(book());

  const committed = await library.updateBook('book-1', draft => ({ ...draft, title: 'Returned title', marker: 'returned' }));
  assert.equal(committed.title, 'Returned title');
  assert.equal(committed.marker, 'returned');
  assert.equal((await library.getBook('book-1')).marker, 'returned');
  await assert.rejects(() => library.updateBook('book-1', () => null), /object/);
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

test('replaceBookContent persists replacement content, resets progress, and retains metadata', async () => {
  installIndexedDB();
  const library = new BookLibrary();
  const original = { ...book(), bookSummary: 'summary', chapterSummaries: { 1: 'chapter' }, searchIndex: ['search'], ragIndex: ['rag'], contentIndex: ['content'], notes: [{ noteId: 'note-1' }], stats: { totalTime: 8, readingDays: {}, hourlyDist: {} } };
  await library.addBook(original);
  await library.updateBook('book-1', book => Object.assign(book, original));

  const committed = await library.replaceBookContent('book-1', { title: 'New title', file: new Blob(['new file']), format: 'txt' });
  const stored = await library.getBook('book-1');
  assert.equal(stored.title, 'New title');
  assert.equal(stored.file.size, 8);
  assert.equal(stored.progress.percent, 0);
  assert.equal(stored.progress.chapterIndex, 0);
  assert.equal(stored.bookSummary, '');
  assert.deepEqual(stored.chapterSummaries, {});
  assert.deepEqual(stored.searchIndex, []);
  assert.deepEqual(stored.ragIndex, []);
  assert.deepEqual(stored.contentIndex, []);
  assert.deepEqual(stored.notes, [{ noteId: 'note-1' }]);
  assert.equal(stored.stats.totalTime, 8);
  assert.equal(stored.folder, 'Reading');
  assert.equal(committed.title, stored.title);
});
