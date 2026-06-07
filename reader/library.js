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

    // 請求瀏覽器持久化儲存保護，防止因硬碟空間不足被自動清除
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then(persisted => {
        console.log('[BookLibrary] Storage persisted status:', persisted);
      }).catch(err => {
        console.warn('[BookLibrary] Failed to request storage persistence:', err);
      });
    }

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

  // 導入/還原書籍（如果現有書庫已有相同的書籍，進行合併）
  async importBook(backupBook) {
    await this._ensureOpen();

    // 1. 獲取所有現有書籍
    const existingBooks = await this.getAllBooks();

    // 2. 尋找相同的書籍 (ID 相同，或 書名+作者+格式 相同)
    const existingBook = existingBooks.find(ex =>
      ex.id === backupBook.id ||
      (ex.title && backupBook.title && ex.title.trim() === backupBook.title.trim() &&
       ex.author && backupBook.author && ex.author.trim() === backupBook.author.trim() &&
       ex.format && backupBook.format && ex.format.toLowerCase() === backupBook.format.toLowerCase())
    );

    let mergedBook;
    if (existingBook) {
      // 合併記錄
      // 進度合併 (以 lastReadAt 較新者為準覆寫閱讀位置)
      const mergedProgress = { ...existingBook.progress, ...backupBook.progress };
      const existingLastRead = existingBook.lastReadAt || 0;
      const backupLastRead = backupBook.lastReadAt || 0;

      if (existingLastRead > backupLastRead) {
        // 保留現有書庫的位置
        if (existingBook.progress) {
          mergedProgress.chapterIndex = existingBook.progress.chapterIndex ?? mergedProgress.chapterIndex;
          mergedProgress.elementIndex = existingBook.progress.elementIndex ?? mergedProgress.elementIndex;
          mergedProgress.activeSentenceIndex = existingBook.progress.activeSentenceIndex ?? mergedProgress.activeSentenceIndex;
          mergedProgress.percent = existingBook.progress.percent ?? mergedProgress.percent;
          mergedProgress.scrollTop = existingBook.progress.scrollTop ?? mergedProgress.scrollTop;
          mergedProgress.pdfPage = existingBook.progress.pdfPage ?? mergedProgress.pdfPage;
          mergedProgress.comicImageIndex = existingBook.progress.comicImageIndex ?? mergedProgress.comicImageIndex;
        }
      }

      // 合併書籤 (避免重複)
      const mergedBookmarks = [...(existingBook.bookmarks || [])];
      if (backupBook.bookmarks) {
        for (const b of backupBook.bookmarks) {
          const isDuplicate = mergedBookmarks.some(ex =>
            ex.bookmarkId === b.bookmarkId ||
            (ex.chapterIndex === b.chapterIndex &&
             ex.elementIndex === b.elementIndex &&
             ex.pdfPage === b.pdfPage &&
             ex.currentPageIndex === b.currentPageIndex)
          );
          if (!isDuplicate) {
            mergedBookmarks.push(b);
          }
        }
      }

      // 合併劃線筆記 (避免重複)
      const mergedNotes = [...(existingBook.notes || [])];
      if (backupBook.notes) {
        for (const n of backupBook.notes) {
          const isDuplicate = mergedNotes.some(ex =>
            ex.noteId === n.noteId ||
            (ex.chapterIndex === n.chapterIndex &&
             ex.sentenceIndex === n.sentenceIndex &&
             ex.text === n.text &&
             ex.type === n.type &&
             ex.pdfPage === n.pdfPage &&
             ex.comicImageIndex === n.comicImageIndex)
          );
          if (!isDuplicate) {
            mergedNotes.push(n);
          }
        }
      }

      // 合併 AI 溝通記錄 (避免重複)
      const mergedAIChats = [...(existingBook.aiChats || [])];
      if (backupBook.aiChats) {
        for (const c of backupBook.aiChats) {
          const isDuplicate = mergedAIChats.some(ex => ex.chatId === c.chatId);
          if (!isDuplicate) {
            mergedAIChats.push(c);
          }
        }
      }

      // 合併閱讀統計資訊
      // 策略：同一天的閱讀時間取兩份資料中的「最大值」而非直接相加，
      //       以防備份-還原後同一段閱讀時間被重複累計（例如同設備備份後還原）。
      //       hourlyDist 同理，同一個小時取最大值。
      //       totalTime 最後從合併後的 readingDays 重新加總，確保與明細一致。
      const mergedReadingDays = { ...(existingBook.stats?.readingDays || {}) };
      if (backupBook.stats?.readingDays) {
        for (const [date, sec] of Object.entries(backupBook.stats.readingDays)) {
          mergedReadingDays[date] = Math.max(mergedReadingDays[date] || 0, sec);
        }
      }

      const mergedHourlyDist = { ...(existingBook.stats?.hourlyDist || {}) };
      if (backupBook.stats?.hourlyDist) {
        for (const [hour, sec] of Object.entries(backupBook.stats.hourlyDist)) {
          mergedHourlyDist[hour] = Math.max(mergedHourlyDist[hour] || 0, sec);
        }
      }

      // totalTime 從合併後的每日資料重新彙總，確保不出現因直接相加導致的虛報時間
      const recalculatedTotalTime = Object.values(mergedReadingDays).reduce((sum, sec) => sum + sec, 0);

      const mergedStats = {
        totalTime: recalculatedTotalTime,
        readingDays: mergedReadingDays,
        hourlyDist: mergedHourlyDist
      };

      mergedBook = {
        id: existingBook.id, // 使用現有書籍的 ID 以免重複
        title: existingBook.title,
        author: existingBook.author,
        format: existingBook.format,
        file: existingBook.file || backupBook.file, // 優先使用現有檔案
        cover: existingBook.cover || backupBook.cover,
        folder: existingBook.folder || backupBook.folder, // 優先使用現有資料夾
        size: existingBook.size || backupBook.size,
        addedAt: Math.min(existingBook.addedAt || Date.now(), backupBook.addedAt || Date.now()),
        lastReadAt: Math.max(existingLastRead, backupLastRead),
        progress: mergedProgress,
        bookmarks: mergedBookmarks,
        notes: mergedNotes,
        aiChats: mergedAIChats,
        stats: mergedStats,
        bookSummary: existingBook.bookSummary || backupBook.bookSummary || '',
        chapterSummaries: { ...(existingBook.chapterSummaries || {}), ...(backupBook.chapterSummaries || {}) }
      };
    } else {
      // 沒找到相同的書籍，直接使用導入的書籍
      mergedBook = backupBook;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.put(mergedBook);

      request.onsuccess = () => resolve(true);
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

  // 更新書籍資料夾
  async updateBookFolder(id, folder) {
    await this._ensureOpen();
    const book = await this.getBook(id);
    if (!book) throw new Error('Book not found');

    book.folder = folder;

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
        currentPageIndex: bookmark.currentPageIndex || 0,
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

  // 累加閱讀統計資訊
  async addReadingDuration(id, seconds) {
    await this._ensureOpen();
    const book = await this.getBook(id);
    if (!book) throw new Error('Book not found');

    if (!book.stats) {
      book.stats = {
        totalTime: 0,
        readingDays: {},
        hourlyDist: {}
      };
    }

    const now = new Date();
    const dateStr = now.getFullYear() + '-' + 
                    String(now.getMonth() + 1).padStart(2, '0') + '-' + 
                    String(now.getDate()).padStart(2, '0');
    const hour = now.getHours();

    book.stats.totalTime = (book.stats.totalTime || 0) + seconds;
    book.stats.readingDays[dateStr] = (book.stats.readingDays[dateStr] || 0) + seconds;
    book.stats.hourlyDist[hour] = (book.stats.hourlyDist[hour] || 0) + seconds;
    book.lastReadAt = Date.now();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.put(book);

      request.onsuccess = () => resolve(book);
      request.onerror = () => reject(request.error);
    });
  }

  // 清理單本書籍的閱讀統計
  async clearBookStats(id) {
    await this._ensureOpen();
    const book = await this.getBook(id);
    if (!book) throw new Error('Book not found');

    book.stats = {
      totalTime: 0,
      readingDays: {},
      hourlyDist: {}
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.put(book);

      request.onsuccess = () => resolve(book);
      request.onerror = () => reject(request.error);
    });
  }

  // 清理所有書籍的閱讀統計
  async clearAllStats() {
    await this._ensureOpen();
    const books = await this.getAllBooks();

    return new Promise((resolve, reject) => {
      if (books.length === 0) {
        resolve(true);
        return;
      }

      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');

      let completed = 0;
      let hasError = false;

      books.forEach(book => {
        book.stats = {
          totalTime: 0,
          readingDays: {},
          hourlyDist: {}
        };
        const request = store.put(book);
        request.onsuccess = () => {
          completed++;
          if (completed === books.length && !hasError) {
            resolve(true);
          }
        };
        request.onerror = () => {
          if (!hasError) {
            hasError = true;
            reject(request.error);
          }
        };
      });
    });
  }

  // 保存 AI 溝通記錄
  async saveAIChat(id, chat) {
    await this._ensureOpen();
    const book = await this.getBook(id);
    if (!book) throw new Error('Book not found');

    if (!book.aiChats) book.aiChats = [];
    
    book.aiChats.push({
      chatId: chat.chatId || 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      createdAt: Date.now(),
      query: chat.query,
      reply: chat.reply
    });

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.put(book);

      request.onsuccess = () => resolve(book.aiChats);
      request.onerror = () => reject(request.error);
    });
  }

  // 刪除單一 AI 溝通記錄
  async deleteAIChat(id, chatId) {
    await this._ensureOpen();
    const book = await this.getBook(id);
    if (!book) throw new Error('Book not found');

    if (book.aiChats) {
      book.aiChats = book.aiChats.filter(c => c.chatId !== chatId);
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.put(book);

      request.onsuccess = () => resolve(book.aiChats);
      request.onerror = () => reject(request.error);
    });
  }

  // 清除全部 AI 溝通記錄
  async clearAllAIChats(id) {
    await this._ensureOpen();
    const book = await this.getBook(id);
    if (!book) throw new Error('Book not found');

    book.aiChats = [];

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.put(book);

      request.onsuccess = () => resolve(book.aiChats);
      request.onerror = () => reject(request.error);
    });
  }

  // 保存全書深度分析摘要
  async saveBookSummary(id, summary) {
    await this._ensureOpen();
    const book = await this.getBook(id);
    if (!book) throw new Error('Book not found');

    book.bookSummary = summary;

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.put(book);

      request.onsuccess = () => resolve(book.bookSummary);
      request.onerror = () => reject(request.error);
    });
  }

  // 保存單個章節的摘要
  async saveChapterSummary(id, index, summary) {
    await this._ensureOpen();
    const book = await this.getBook(id);
    if (!book) throw new Error('Book not found');

    if (!book.chapterSummaries) book.chapterSummaries = {};
    book.chapterSummaries[index] = summary;

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readwrite');
      const store = transaction.objectStore('books');
      const request = store.put(book);

      request.onsuccess = () => resolve(book.chapterSummaries);
      request.onerror = () => reject(request.error);
    });
  }
}
