// reader/library.js
// 基於 IndexedDB 的書庫管理模組，提供書籍儲存、刪除、歷史記錄與進度更新功能

const DB_NAME = 'EdgeReaderDB';
const DB_VERSION = 1;

export class BookLibrary {
  constructor() {
    this.db = null;
  }

  // 打開資料庫
  async open() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // 建立書籍儲存空間
        if (!db.objectStoreNames.contains('books')) {
          const bookStore = db.createObjectStore('books', { keyPath: 'id' });
          bookStore.createIndex('addedAt', 'addedAt', { unique: false });
          bookStore.createIndex('lastReadAt', 'lastReadAt', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('IndexedDB open error:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  // 確保 DB 處於開啟狀態
  async _ensureOpen() {
    if (!this.db) {
      await this.open();
    }
  }

  // 添加書籍
  async addBook({ id, title, author, format, file, cover, size }) {
    await this._ensureOpen();
    const book = {
      id: id || 'book_' + Date.now(),
      title: title || 'Unknown Title',
      author: author || 'Unknown Author',
      format: format.toLowerCase(),
      file,         // Blob
      cover,        // string (DataURL) or Blob
      size: size || 0,
      addedAt: Date.now(),
      lastReadAt: 0,
      progress: {
        percent: 0,
        chapterIndex: 0,
        elementIndex: 0,
        activeSentenceIndex: 0,
        pdfPage: 1,
        comicImageIndex: 0,
        scrollTop: 0
      },
      bookmarks: [],
      notes: [] // 保存劃線高亮與筆記
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.add(book);

      request.onsuccess = () => resolve(book);
      request.onerror = () => reject(request.error);
    });
  }

  // 獲取所有書籍 (按最後閱讀時間，再按新增時間排序)
  async getAllBooks() {
    await this._ensureOpen();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readonly');
      const store = transaction.objectStore('books');
      const request = store.getAll();

      request.onsuccess = () => {
        const books = request.result;
        // 排序：有閱讀過的排在前面（按最後閱讀時間降序），其次按添加時間降序
        books.sort((a, b) => {
          if (b.lastReadAt !== a.lastReadAt) {
            return b.lastReadAt - a.lastReadAt;
          }
          return b.addedAt - a.addedAt;
        });
        resolve(books);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // 獲取單本書籍
  async getBook(id) {
    await this._ensureOpen();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readonly');
      const store = transaction.objectStore('books');
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // 刪除書籍
  async deleteBook(id) {
    await this._ensureOpen();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.delete(id);

      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }

  // 更新閱讀進度
  async updateProgress(id, progressUpdate) {
    await this._ensureOpen();
    const book = await this.getBook(id);
    if (!book) throw new Error('Book not found');

    book.progress = { ...book.progress, ...progressUpdate };
    book.lastReadAt = Date.now();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.put(book);

      request.onsuccess = () => resolve(book);
      request.onerror = () => reject(request.error);
    });
  }

  // 更新書籍封面
  async updateBookCover(id, cover) {
    await this._ensureOpen();
    const book = await this.getBook(id);
    if (!book) throw new Error('Book not found');

    book.cover = cover;

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.put(book);

      request.onsuccess = () => resolve(book);
      request.onerror = () => reject(request.error);
    });
  }

  // 保存或更新高亮筆記
  async saveNote(id, note) {
    await this._ensureOpen();
    const book = await this.getBook(id);
    if (!book) throw new Error('Book not found');

    if (!book.notes) book.notes = [];
    
    // 檢查是否已存在同一個高亮 (基於選取字元範圍或 selector)
    const existingIndex = book.notes.findIndex(n => n.noteId === note.noteId);
    if (existingIndex > -1) {
      book.notes[existingIndex] = { ...book.notes[existingIndex], ...note };
    } else {
      book.notes.push({
        noteId: 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        createdAt: Date.now(),
        ...note
      });
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.put(book);

      request.onsuccess = () => resolve(book.notes);
      request.onerror = () => reject(request.error);
    });
  }

  // 刪除高亮筆記
  async deleteNote(id, noteId) {
    await this._ensureOpen();
    const book = await this.getBook(id);
    if (!book) throw new Error('Book not found');

    if (book.notes) {
      book.notes = book.notes.filter(n => n.noteId !== noteId);
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.put(book);

      request.onsuccess = () => resolve(book.notes);
      request.onerror = () => reject(request.error);
    });
  }

  // 保存書籤
  async saveBookmark(id, bookmark) {
    await this._ensureOpen();
    const book = await this.getBook(id);
    if (!book) throw new Error('Book not found');

    if (!book.bookmarks) book.bookmarks = [];
    
    // 檢查是否已存在該書籤
    const existingIndex = book.bookmarks.findIndex(b => b.chapterIndex === bookmark.chapterIndex && b.elementIndex === bookmark.elementIndex && b.pdfPage === bookmark.pdfPage);
    if (existingIndex === -1) {
      book.bookmarks.push({
        bookmarkId: 'bookmark_' + Date.now(),
        createdAt: Date.now(),
        title: bookmark.title || 'Bookmark',
        chapterIndex: bookmark.chapterIndex || 0,
        elementIndex: bookmark.elementIndex || 0,
        pdfPage: bookmark.pdfPage || 1
      });
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.put(book);

      request.onsuccess = () => resolve(book.bookmarks);
      request.onerror = () => reject(request.error);
    });
  }

  // 刪除書籤
  async deleteBookmark(id, bookmarkId) {
    await this._ensureOpen();
    const book = await this.getBook(id);
    if (!book) throw new Error('Book not found');

    if (book.bookmarks) {
      book.bookmarks = book.bookmarks.filter(b => b.bookmarkId !== bookmarkId);
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.put(book);

      request.onsuccess = () => resolve(book.bookmarks);
      request.onerror = () => reject(request.error);
    });
  }
}
