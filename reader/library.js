const DB_NAME = 'EdgeReaderDB';
const DB_VERSION = 1;

const clone = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));

export function resetContentDerivedState(book) {
  const result = clone(book);
  result.bookSummary = '';
  result.chapterSummaries = {};
  for (const key of ['searchIndex', 'ragIndex', 'contentIndex']) if (key in result) result[key] = [];
  result.progress = { ...(result.progress || {}), percent: 0, chapterIndex: 0, elementIndex: 0, activeSentenceIndex: 0, ttsActiveSentenceIndex: 0, ttsChapterIndex: 0, pdfPage: 1, comicImageIndex: 0, currentPageIndex: 0, scrollTop: 0 };
  return result;
}

export function mergeById(current = [], incoming = [], idKey, incomingWins = true) {
  const result = current.map(clone);
  const identity = item => item[idKey] || `${idKey}:${JSON.stringify(item)}`;
  for (const item of incoming) {
    const index = result.findIndex(existing => identity(existing) === identity(item));
    if (index < 0) result.push(clone(item));
    else if (incomingWins) result[index] = { ...result[index], ...clone(item) };
  }
  return result;
}

export function mergeRestoredBook(current, backup, { restoreFile = false, progressPreference = 'current' } = {}) {
  const result = { ...clone(current), ...clone(backup), id: current.id };
  result.file = restoreFile ? backup.file : current.file;
  result.cover = restoreFile ? (backup.cover || current.cover) : current.cover;
  result.progress = clone(progressPreference === 'backup' ? backup.progress || current.progress : current.progress || backup.progress);
  result.notes = mergeById(current.notes, backup.notes, 'noteId');
  result.bookmarks = mergeById(current.bookmarks, backup.bookmarks, 'bookmarkId');
  result.aiChats = mergeById(current.aiChats, backup.aiChats, 'chatId');
  const readingDays = { ...(current.stats?.readingDays || {}) };
  for (const [date, seconds] of Object.entries(backup.stats?.readingDays || {})) readingDays[date] = Math.max(readingDays[date] || 0, seconds);
  const hourlyDist = { ...(current.stats?.hourlyDist || {}) };
  for (const [hour, seconds] of Object.entries(backup.stats?.hourlyDist || {})) hourlyDist[hour] = Math.max(hourlyDist[hour] || 0, seconds);
  result.stats = { ...(current.stats || {}), ...(backup.stats || {}), readingDays, hourlyDist };
  result.stats.totalTime = Object.values(result.stats.readingDays).reduce((sum, seconds) => sum + seconds, 0) || result.stats.totalTime || 0;
  return restoreFile ? resetContentDerivedState(result) : result;
}

export class BookLibrary {
  constructor() { this.db = null; }

  async open() {
    if (this.db) return this.db;
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('books')) {
          const store = db.createObjectStore('books', { keyPath: 'id' });
          store.createIndex('addedAt', 'addedAt', { unique: false });
          store.createIndex('lastReadAt', 'lastReadAt', { unique: false });
        }
      };
      request.onsuccess = event => { this.db = event.target.result; resolve(this.db); };
      request.onerror = () => reject(request.error);
    });
  }

  async _ensureOpen() { if (!this.db) await this.open(); }

  _cleanBookForStorage(book) {
    const clean = clone(book);
    if (typeof File !== 'undefined' && clean.file instanceof File) clean.file = new Blob([clean.file], { type: clean.file.type });
    if (typeof File !== 'undefined' && clean.cover instanceof File) clean.cover = new Blob([clean.cover], { type: clean.cover.type });
    return clean;
  }

  async addBook({ id, title, author, format, file, cover, size, fileHash }) {
    await this._ensureOpen();
    const book = { id: id || `book_${Date.now()}`, title: title || 'Unknown Title', author: author || 'Unknown Author', format: format.toLowerCase(), file, cover, size: size || 0, fileHash: fileHash || '', addedAt: Date.now(), lastReadAt: 0, progress: { percent: 0, chapterIndex: 0, elementIndex: 0, activeSentenceIndex: 0, ttsActiveSentenceIndex: 0, ttsChapterIndex: 0, pdfPage: 1, comicImageIndex: 0, scrollTop: 0 }, bookmarks: [], notes: [] };
    const transaction = this.db.transaction('books', 'readwrite');
    transaction.objectStore('books').add(this._cleanBookForStorage(book));
    return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(clone(book)); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted')); });
  }

  async updateBook(id, updater) {
    await this._ensureOpen();
    if (typeof updater !== 'function') throw new TypeError('updateBook requires a synchronous updater function');
    const transaction = this.db.transaction('books', 'readwrite');
    const store = transaction.objectStore('books');
    const getRequest = store.get(id);
    let draft;
    let committedResult;
    let updaterError;
    getRequest.onsuccess = () => {
      if (!getRequest.result) { updaterError = new Error(`Book not found: ${id}`); transaction.abort(); return; }
      try {
        draft = clone(getRequest.result);
        committedResult = updater(draft);
        if (committedResult && typeof committedResult.then === 'function') throw new TypeError('updateBook updater must be synchronous');
        store.put(this._cleanBookForStorage(draft));
      } catch (error) { updaterError = error; transaction.abort(); }
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => { if (!settled) { settled = true; reject(error); } };
      getRequest.onerror = () => fail(getRequest.error);
      transaction.onerror = () => fail(updaterError || transaction.error || getRequest.error || new Error('IndexedDB transaction failed'));
      transaction.onabort = () => fail(updaterError || transaction.error || new Error('IndexedDB transaction aborted'));
      transaction.oncomplete = () => { if (!settled) { settled = true; resolve(clone(committedResult === undefined ? draft : committedResult)); } };
    });
  }

  async replaceBookContent(id, incoming) {
    return this.updateBook(id, book => resetContentDerivedState({ ...book, ...incoming, format: incoming.format?.toLowerCase() || book.format, file: incoming.file, cover: incoming.cover || book.cover, size: incoming.size || book.size, fileHash: incoming.fileHash || book.fileHash }));
  }

  async importBook(backupBook, options = {}) {
    await this._ensureOpen();
    const transaction = this.db.transaction('books', 'readwrite');
    const store = transaction.objectStore('books');
    const request = store.getAll();
    let result;
    let error;
    request.onsuccess = () => {
      try {
        const existing = request.result.find(book => book.id === backupBook.id || (book.title && backupBook.title && book.title.trim() === backupBook.title.trim() && book.author && backupBook.author && book.author.trim() === backupBook.author.trim() && book.format && backupBook.format && book.format.toLowerCase() === backupBook.format.toLowerCase()));
        result = existing ? mergeRestoredBook(existing, backupBook, options) : clone(backupBook);
        store.put(this._cleanBookForStorage(result));
      } catch (cause) { error = cause; transaction.abort(); }
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = cause => { if (!settled) { settled = true; reject(cause); } };
      request.onerror = () => fail(request.error);
      transaction.onerror = () => fail(error || transaction.error || request.error);
      transaction.onabort = () => fail(error || transaction.error || new Error('IndexedDB transaction aborted'));
      transaction.oncomplete = () => { if (!settled) { settled = true; resolve(clone(result)); } };
    });
  }

  async getAllBooks() { await this._ensureOpen(); return new Promise((resolve, reject) => { const tx = this.db.transaction('books', 'readonly'); const request = tx.objectStore('books').getAll(); request.onsuccess = () => resolve(request.result.sort((a, b) => (b.lastReadAt - a.lastReadAt) || (b.addedAt - a.addedAt))); request.onerror = () => reject(request.error); }); }
  async getBook(id) { await this._ensureOpen(); return new Promise((resolve, reject) => { const tx = this.db.transaction('books', 'readonly'); const request = tx.objectStore('books').get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
  async deleteBook(id) { await this._ensureOpen(); return new Promise((resolve, reject) => { const tx = this.db.transaction('books', 'readwrite'); tx.objectStore('books').delete(id); tx.oncomplete = () => resolve(true); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted')); }); }

  async updateProgress(id, update) { return this.updateBook(id, book => { book.progress = { ...book.progress, ...update }; book.lastReadAt = Date.now(); return book; }); }
  async updateBookCover(id, cover) { return this.updateBook(id, book => { book.cover = cover; return book; }); }
  async updateBookFolder(id, folder) { return this.updateBook(id, book => { book.folder = folder; return book; }); }
  async saveNote(id, note) { return this.updateBook(id, book => { book.notes ||= []; const index = book.notes.findIndex(item => item.noteId === note.noteId); if (index >= 0) book.notes[index] = { ...book.notes[index], ...note }; else book.notes.push({ noteId: `note_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, createdAt: Date.now(), ...note }); return book.notes; }); }
  async deleteNote(id, noteId) { return this.updateBook(id, book => { book.notes = (book.notes || []).filter(note => note.noteId !== noteId); return book.notes; }); }
  async saveBookmark(id, bookmark) { return this.updateBook(id, book => { book.bookmarks ||= []; if (!book.bookmarks.some(item => item.chapterIndex === bookmark.chapterIndex && item.elementIndex === bookmark.elementIndex && item.pdfPage === bookmark.pdfPage)) book.bookmarks.push({ bookmarkId: `bookmark_${Date.now()}`, createdAt: Date.now(), title: bookmark.title || 'Bookmark', chapterIndex: bookmark.chapterIndex || 0, elementIndex: bookmark.elementIndex || 0, currentPageIndex: bookmark.currentPageIndex || 0, pdfPage: bookmark.pdfPage || 1 }); return book.bookmarks; }); }
  async deleteBookmark(id, bookmarkId) { return this.updateBook(id, book => { book.bookmarks = (book.bookmarks || []).filter(item => item.bookmarkId !== bookmarkId); return book.bookmarks; }); }
  async addReadingDuration(id, seconds) { return this.updateBook(id, book => { book.stats ||= { totalTime: 0, readingDays: {}, hourlyDist: {} }; const now = new Date(); const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; const hour = now.getHours(); book.stats.totalTime = (book.stats.totalTime || 0) + seconds; book.stats.readingDays[date] = (book.stats.readingDays[date] || 0) + seconds; book.stats.hourlyDist[hour] = (book.stats.hourlyDist[hour] || 0) + seconds; book.lastReadAt = Date.now(); return book; }); }
  async clearBookStats(id) { return this.updateBook(id, book => { book.stats = { totalTime: 0, readingDays: {}, hourlyDist: {} }; return book; }); }
  async clearAllStats() { const books = await this.getAllBooks(); await Promise.all(books.map(book => this.clearBookStats(book.id))); return true; }
  async saveAIChat(id, chat) { return this.updateBook(id, book => { book.aiChats ||= []; book.aiChats.push({ chatId: chat.chatId || `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, createdAt: Date.now(), query: chat.query, reply: chat.reply }); return book.aiChats; }); }
  async deleteAIChat(id, chatId) { return this.updateBook(id, book => { book.aiChats = (book.aiChats || []).filter(chat => chat.chatId !== chatId); return book.aiChats; }); }
  async clearAllAIChats(id) { return this.updateBook(id, book => { book.aiChats = []; return book.aiChats; }); }
  async saveBookSummary(id, summary) { return this.updateBook(id, book => { book.bookSummary = summary; return book.bookSummary; }); }
  async saveChapterSummary(id, index, summary) { return this.updateBook(id, book => { book.chapterSummaries ||= {}; book.chapterSummaries[index] = summary; return book.chapterSummaries; }); }
}
