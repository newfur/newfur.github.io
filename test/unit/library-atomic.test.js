import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
import { BookLibrary, applyCommittedBookToList } from '../../reader/library.js';

function installIndexedDB() {
  globalThis.indexedDB = new FDBFactory();
  globalThis.IDBKeyRange = FDBKeyRange;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { persist: async () => true } } });
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

test('generated annotation IDs survive missing supplied IDs', async () => {
  installIndexedDB();
  const library = new BookLibrary();
  await library.addBook(book());
  await Promise.all([
    library.saveNote('book-1', { noteId: undefined, text: 'note' }),
    library.saveBookmark('book-1', { bookmarkId: null, chapterIndex: 1, elementIndex: 2, pdfPage: 3 }),
    library.saveAIChat('book-1', { chatId: '', query: 'q', reply: 'a' }),
  ]);
  const stored = await library.getBook('book-1');
  assert.match(stored.notes[0].noteId, /^note_/);
  assert.match(stored.bookmarks[0].bookmarkId, /^bookmark_/);
  assert.match(stored.aiChats[0].chatId, /^chat_/);
});

test('committed book application replaces a list entry without mutating the old entry', () => {
  const oldBook = { id: 'book-1', fileHash: '' };
  const books = [oldBook, { id: 'book-2' }];
  const committed = { id: 'book-1', fileHash: 'hash' };
  const updated = applyCommittedBookToList(books, committed);
  assert.equal(oldBook.fileHash, '');
  assert.equal(updated[0], committed);
  assert.notEqual(updated, books);
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
  assert.equal('bookSummary' in stored, false);
  assert.deepEqual(stored.chapterSummaries, {});
  assert.equal('searchIndex' in stored, false);
  assert.equal('ragIndex' in stored, false);
  assert.equal('contentIndex' in stored, false);
  assert.deepEqual(stored.notes, [{ noteId: 'note-1' }]);
  assert.equal(stored.stats.totalTime, 8);
  assert.equal(stored.folder, 'Reading');
  assert.equal(committed.title, stored.title);
});

test('concurrent summaries preserve book and chapter summaries', async () => {
  installIndexedDB();
  const library = new BookLibrary();
  await library.addBook(book());
  await Promise.all([
    library.saveBookSummary('book-1', 'book summary'),
    library.saveChapterSummary('book-1', 2, 'chapter summary'),
  ]);
  const stored = await library.getBook('book-1');
  assert.equal(stored.bookSummary, 'book summary');
  assert.equal(stored.chapterSummaries[2], 'chapter summary');
});

test('typed Blob content survives storage cleaning and IndexedDB round trip', async () => {
  installIndexedDB();
  const library = new BookLibrary();
  const file = new Blob(['actual bytes'], { type: 'text/plain;charset=utf-8' });
  const clean = library._cleanBookForStorage({ id: 'book-1', file });
  assert.ok(clean.file instanceof Blob);
  assert.equal(clean.file.type, 'text/plain;charset=utf-8');
  assert.equal(await clean.file.text(), 'actual bytes');

  await library.addBook({ ...book(), file });
  const stored = await library.getBook('book-1');
  assert.ok(stored.file instanceof Blob);
  assert.equal(stored.file.type, 'text/plain;charset=utf-8');
  assert.equal(await stored.file.text(), 'actual bytes');
  assert.equal('name' in stored.file, false);
});

test('native File input normalizes to the Blob representation persisted by the app', async () => {
  installIndexedDB();
  Object.defineProperty(globalThis, 'File', { configurable: true, value: File });
  const library = new BookLibrary();
  const file = new File(['native file bytes'], 'reader.txt', { type: 'text/plain;charset=utf-8' });
  const clean = library._cleanBookForStorage({ id: 'book-1', file });
  assert.ok(clean.file instanceof Blob);
  assert.equal(clean.file instanceof File, false);
  assert.equal(clean.file.type, 'text/plain;charset=utf-8');
  assert.equal(await clean.file.text(), 'native file bytes');
  assert.equal('name' in clean.file, false);

  await library.addBook({ ...book(), file });
  const stored = await library.getBook('book-1');
  assert.ok(stored.file instanceof Blob);
  assert.equal(stored.file instanceof File, false);
  assert.equal(stored.file.type, 'text/plain;charset=utf-8');
  assert.equal(await stored.file.text(), 'native file bytes');
  assert.equal('name' in stored.file, false);
});

test('clearAllStats rolls back every book on a real IndexedDB constraint failure', async () => {
  installIndexedDB();
  const library = new BookLibrary();
  await library.addBook(book('book-1'));
  await library.addBook(book('book-2'));
  await library.updateBook('book-1', value => { value.stats = { totalTime: 10, readingDays: { day: 10 }, hourlyDist: {} }; });
  await library.updateBook('book-2', value => { value.stats = { totalTime: 20, readingDays: { day: 20 }, hourlyDist: {} }; });
  library.db.close();
  library.db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('EdgeReaderDB', 2);
    request.onupgradeneeded = () => request.transaction.objectStore('books').createIndex('uniqueStatsTotal', 'stats.totalTime', { unique: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  await assert.rejects(() => library.clearAllStats(), error => error?.name === 'ConstraintError');
  assert.deepEqual((await library.getBook('book-1')).stats.readingDays, { day: 10 });
  assert.deepEqual((await library.getBook('book-2')).stats.readingDays, { day: 20 });
});
