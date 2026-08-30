import test from 'node:test';
import assert from 'node:assert/strict';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import FDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange';
import {
  BookLibrary,
  mergeRestoredBook,
  resetContentDerivedState,
} from '../../reader/library.js';

function setup() {
  globalThis.indexedDB = new FDBFactory();
  globalThis.IDBKeyRange = FDBKeyRange;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { persist: async () => true } } });
}

function existing() {
  return {
    id: 'book-1', title: 'Old', author: 'A', format: 'txt', file: new Blob(['old']),
    folder: 'Reading', progress: { percent: 80, chapterIndex: 4 },
    notes: [{ noteId: 'note-1', text: 'current' }],
    bookmarks: [{ bookmarkId: 'bookmark-1', title: 'current' }],
    stats: { totalTime: 10, readingDays: { day: 10 }, hourlyDist: {} },
    bookSummary: 'old summary', chapterSummaries: { 1: 'old chapter' },
    searchIndex: ['old'], ragIndex: ['old'], contentIndex: ['old'],
  };
}

test('replacement resets derived state but retains annotations, folder, and stats', () => {
  const result = resetContentDerivedState({ ...existing(), progress: { percent: 80, chapterIndex: 4 } });
  assert.equal('bookSummary' in result, false);
  assert.deepEqual(result.chapterSummaries, {});
  assert.equal('searchIndex' in result, false);
  assert.equal('ragIndex' in result, false);
  assert.equal('contentIndex' in result, false);
  assert.equal(result.progress.percent, 80);
  assert.equal(result.folder, 'Reading');
  assert.equal(result.notes[0].noteId, 'note-1');
  assert.equal(result.stats.totalTime, 10);
});

test('restore options control file and progress precedence and merge annotations by IDs', () => {
  const result = mergeRestoredBook(existing(), {
    id: 'backup-id', title: 'New', author: 'A', format: 'txt', file: new Blob(['new']),
    progress: { percent: 20, chapterIndex: 1 },
    notes: [{ noteId: 'note-1', text: 'backup' }, { noteId: 'note-2', text: 'new' }],
    bookmarks: [{ bookmarkId: 'bookmark-1', title: 'backup' }],
  }, { restoreFile: true, progressPreference: 'backup' });
  assert.equal(result.file.size, 3);
  assert.equal(result.progress.percent, 20);
  assert.deepEqual(result.notes.map(note => note.noteId), ['note-1', 'note-2']);
  assert.equal(result.notes[0].text, 'backup');
  assert.equal(result.bookmarks[0].title, 'backup');

  const metadata = mergeRestoredBook(existing(), { ...result, file: new Blob(['metadata']) }, { restoreFile: false, progressPreference: 'current' });
  assert.equal(metadata.file.size, 3);
  assert.equal(metadata.progress.percent, 80);

  const currentProgress = mergeRestoredBook(existing(), { ...result, progress: { percent: 20 } }, { restoreFile: true, progressPreference: 'current' });
  assert.equal(currentProgress.progress.percent, 80);
});

test('import merges inside one write transaction and returns the committed book', async () => {
  setup();
  const library = new BookLibrary();
  await library.addBook({ ...existing(), format: 'txt' });
  await library.updateBook('book-1', book => {
    Object.assign(book, existing());
    return book;
  });
  const imported = await library.importBook({ id: 'book-1', title: 'Old', author: 'A', format: 'txt', file: new Blob(['backup']), notes: [{ noteId: 'note-2' }] });
  assert.equal(imported.id, 'book-1');
  assert.deepEqual((await library.getBook('book-1')).notes.map(note => note.noteId), ['note-1', 'note-2']);
});
