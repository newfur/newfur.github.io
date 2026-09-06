// reader/library.js
// 基於 IndexedDB 的書庫管理模組，提供書籍儲存、刪除、歷史記錄與進度更新功能
// V2 架構：將 1KB 的書籍元數據/進度 (books) 與 50MB+ 的檔案本體 (book_files) 徹底分離解耦
// 徹底根治因頻繁保存進度導致的重複寫入與 130GB 磁碟膨脹

const DB_NAME = 'EdgeReaderDB_V2';
const DB_VERSION = 1;
const LEGACY_DB_NAME = 'EdgeReaderDB';

export class BookLibrary {
  constructor() {
    this.db = null;
    this._progressQueue = null;
    this._cleanupTriggered = false;
  }

  // 打開資料庫
  async open() {
    if (this.db) return this.db;

    // 請求瀏覽器持久化儲存保護
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then(persisted => {
        console.log('[BookLibrary] Storage persisted status:', persisted);
      }).catch(err => {
        console.warn('[BookLibrary] Failed to request storage persistence:', err);
      });
    }

    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // 建立書籍元數據儲存空間 (不存大型檔案，僅存 1KB 元數據與進度)
        if (!db.objectStoreNames.contains('books')) {
          const bookStore = db.createObjectStore('books', { keyPath: 'id' });
          bookStore.createIndex('addedAt', 'addedAt', { unique: false });
          bookStore.createIndex('lastReadAt', 'lastReadAt', { unique: false });
        }

        // 建立獨立的書籍二進制檔案儲存空間 (僅在導入時寫入一次，後續進度更新絕不觸碰)
        if (!db.objectStoreNames.contains('book_files')) {
          db.createObjectStore('book_files', { keyPath: 'id' });
        }
      };

      request.onsuccess = (event) => {
        resolve(event.target.result);
      };

      request.onerror = (event) => {
        console.error('IndexedDB open error:', event.target.error);
        reject(event.target.error);
      };
    });

    // 檢查並執行舊版資料庫遷移與 130GB 瘦身清理
    if (!this._cleanupTriggered) {
      this._cleanupTriggered = true;
      this._triggerLegacyCleanup().catch(e => console.warn('[BookLibrary] Legacy cleanup error:', e));
    }

    return this.db;
  }

  // 確保 DB 處於開啟狀態
  async _ensureOpen() {
    if (!this.db) {
      await this.open();
    }
  }

  // 檢查並執行舊版資料庫瘦身遷移 (將龐大舊庫轉移到 V2 並徹底物理刪除舊庫，釋放 130GB 空間)
  async _triggerLegacyCleanup() {
    if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;
    try {
      if (localStorage.getItem('edgereader_v2_migrated') === 'done') {
        return;
      }

      console.log('[BookLibrary] Checking for legacy EdgeReaderDB to reclaim space...');
      const checkReq = indexedDB.open(LEGACY_DB_NAME);

      checkReq.onupgradeneeded = (e) => {
        // 舊庫不存在，新建立的空庫，直接關閉並刪除
        const tempDb = e.target.result;
        tempDb.close();
        indexedDB.deleteDatabase(LEGACY_DB_NAME);
        localStorage.setItem('edgereader_v2_migrated', 'done');
      };

      checkReq.onsuccess = async (e) => {
        const legacyDb = e.target.result;
        if (!legacyDb.objectStoreNames.contains('books')) {
          legacyDb.close();
          indexedDB.deleteDatabase(LEGACY_DB_NAME);
          localStorage.setItem('edgereader_v2_migrated', 'done');
          return;
        }

        try {
          // 讀取舊庫的所有書籍
          const legacyBooks = await new Promise((res, rej) => {
            const tx = legacyDb.transaction(['books'], 'readonly');
            const req = tx.objectStore('books').getAll();
            req.onsuccess = () => res(req.result || []);
            req.onerror = () => rej(req.error);
          });

          if (legacyBooks && legacyBooks.length > 0) {
            console.log(`[BookLibrary] Migrating ${legacyBooks.length} books from legacy EdgeReaderDB to V2...`);
            for (const book of legacyBooks) {
              const fileBlob = book.file;
              const cleanMeta = this._cleanBookForStorage(book);
              if (cleanMeta && cleanMeta.stats) {
                if (typeof cleanMeta.stats !== 'object') {
                  cleanMeta.stats = { totalTime: Number(cleanMeta.stats) || 0, readingDays: {}, hourlyDist: {} };
                }
                if (!cleanMeta.stats.readingDays) cleanMeta.stats.readingDays = {};
                if (!cleanMeta.stats.hourlyDist) cleanMeta.stats.hourlyDist = {};
                const sum = Object.values(cleanMeta.stats.readingDays).reduce((s, v) => s + (Number(v) || 0), 0);
                if (cleanMeta.stats.totalTime > 0 && sum === 0) {
                  const now = new Date();
                  const dateStr = now.getFullYear() + '-' + 
                                  String(now.getMonth() + 1).padStart(2, '0') + '-' + 
                                  String(now.getDate()).padStart(2, '0');
                  cleanMeta.stats.readingDays[dateStr] = cleanMeta.stats.totalTime;
                }
              }

              await new Promise((res, rej) => {
                const tx = this.db.transaction(['books', 'book_files'], 'readwrite');
                tx.objectStore('books').put(cleanMeta);
                if (fileBlob) {
                  let f = fileBlob;
                  if (typeof File !== 'undefined' && f instanceof File) {
                    f = new Blob([f], { type: f.type });
                  }
                  tx.objectStore('book_files').put({ id: book.id, file: f });
                }
                tx.oncomplete = () => res();
                tx.onerror = () => rej(tx.error);
              });
            }
            console.log('[BookLibrary] Successfully migrated all books to EdgeReaderDB_V2!');
          }

          legacyDb.close();
          // ★★★ 核心：物理刪除膨脹了 130GB 的舊資料庫，系統底層立刻釋放所有 orphaned blob 檔案 ★★★
          const delReq = indexedDB.deleteDatabase(LEGACY_DB_NAME);
          delReq.onsuccess = () => {
            console.log('[BookLibrary] Legacy EdgeReaderDB DELETED successfully! Reclaimed disk space.');
            localStorage.setItem('edgereader_v2_migrated', 'done');
          };
          delReq.onerror = (err) => {
            console.warn('[BookLibrary] Failed to delete legacy database:', err);
            localStorage.setItem('edgereader_v2_migrated', 'done');
          };
        } catch (err) {
          console.error('[BookLibrary] Migration error:', err);
          try { legacyDb.close(); } catch (e) {}
        }
      };

      checkReq.onerror = () => {
        localStorage.setItem('edgereader_v2_migrated', 'done');
      };
    } catch (e) {
      console.warn('[BookLibrary] _triggerLegacyCleanup failed:', e);
    }
  }

  // 輔助函數：清理 metadata，確保 metadata 中絕不包含大型 file Blob
  _cleanBookForStorage(book) {
    if (!book) return book;
    const clean = { ...book };
    delete clean.file; // 絕對不將大型 file 放入 books store
    if (clean.cover && typeof File !== 'undefined' && clean.cover instanceof File) {
      clean.cover = new Blob([clean.cover], { type: clean.cover.type || 'image/jpeg' });
    }
    return clean;
  }

  // 添加書籍
  async addBook({ id, title, author, format, file, cover, size, fileHash }) {
    await this._ensureOpen();
    const bookId = id || 'book_' + Date.now();
    const book = {
      id: bookId,
      title: title || 'Unknown Title',
      author: author || 'Unknown Author',
      format: format.toLowerCase(),
      cover,        // string (DataURL) or Blob
      size: size || 0,
      fileHash: fileHash || '',
      addedAt: Date.now(),
      lastReadAt: 0,
      progress: {
        percent: 0,
        chapterIndex: 0,
        elementIndex: 0,
        activeSentenceIndex: 0,
        ttsActiveSentenceIndex: 0,
        ttsChapterIndex: 0,
        pdfPage: 1,
        comicImageIndex: 0,
        scrollTop: 0
      },
      bookmarks: [],
      notes: [] // 保存劃線高亮與筆記
    };

    let cleanFile = file;
    if (cleanFile && typeof File !== 'undefined' && cleanFile instanceof File) {
      cleanFile = new Blob([cleanFile], { type: cleanFile.type });
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books', 'book_files'], 'readwrite');
      const store = transaction.objectStore('books');
      const fileStore = transaction.objectStore('book_files');

      store.add(this._cleanBookForStorage(book));
      if (cleanFile) {
        fileStore.put({ id: bookId, file: cleanFile });
      }

      transaction.oncomplete = () => resolve({ ...book, file: cleanFile });
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // 覆蓋書籍檔案內容與元數據
  async replaceBookContent(id, { title, author, format, file, cover, size, fileHash }) {
    await this._ensureOpen();
    const book = await this.getBookMetadata(id);
    if (!book) throw new Error('Book not found');

    book.title = title || book.title;
    book.author = author || book.author;
    book.format = format ? format.toLowerCase() : book.format;
    book.cover = cover || book.cover;
    book.size = size || book.size;
    book.fileHash = fileHash || book.fileHash;
    
    // 重置位置相關的進度，因為新文件的章節結構可能不同
    if (book.progress) {
      book.progress.chapterIndex = 0;
      book.progress.elementIndex = 0;
      book.progress.scrollTop = 0;
      book.progress.ttsActiveSentenceIndex = 0;
      book.progress.ttsChapterIndex = 0;
      book.progress.activeSentenceIndex = 0;
      book.progress.currentPageIndex = 0;
      book.progress.pdfPage = 1;
      book.progress.comicImageIndex = 0;
      book.progress.percent = 0;
    }

    let cleanFile = file;
    if (cleanFile && typeof File !== 'undefined' && cleanFile instanceof File) {
      cleanFile = new Blob([cleanFile], { type: cleanFile.type });
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books', 'book_files'], 'readwrite');
      const store = transaction.objectStore('books');
      const fileStore = transaction.objectStore('book_files');

      store.put(this._cleanBookForStorage(book));
      if (cleanFile) {
        fileStore.put({ id, file: cleanFile });
      }

      transaction.oncomplete = () => resolve({ ...book, file: cleanFile });
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // 更新書籍記錄（元數據更新，帶排隊保護，不碰檔案）
  async updateBook(book) {
    if (!book || !book.id) return null;
    return this._mutateBook(book.id, (existing) => {
      const clean = this._cleanBookForStorage(book);
      Object.assign(existing, clean);
      return existing;
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
      const mergedProgress = { ...existingBook.progress, ...backupBook.progress };
      const existingLastRead = existingBook.lastReadAt || 0;
      const backupLastRead = backupBook.lastReadAt || 0;

      if (existingLastRead > backupLastRead) {
        if (existingBook.progress) {
          mergedProgress.chapterIndex = existingBook.progress.chapterIndex ?? mergedProgress.chapterIndex;
          mergedProgress.elementIndex = existingBook.progress.elementIndex ?? mergedProgress.elementIndex;
          mergedProgress.activeSentenceIndex = existingBook.progress.activeSentenceIndex ?? mergedProgress.activeSentenceIndex;
          mergedProgress.ttsChapterIndex = existingBook.progress.ttsChapterIndex ?? mergedProgress.ttsChapterIndex;
          mergedProgress.ttsActiveSentenceIndex = existingBook.progress.ttsActiveSentenceIndex ?? mergedProgress.ttsActiveSentenceIndex;
          mergedProgress.percent = existingBook.progress.percent ?? mergedProgress.percent;
          mergedProgress.scrollTop = existingBook.progress.scrollTop ?? mergedProgress.scrollTop;
          mergedProgress.pdfPage = existingBook.progress.pdfPage ?? mergedProgress.pdfPage;
          mergedProgress.comicImageIndex = existingBook.progress.comicImageIndex ?? mergedProgress.comicImageIndex;
        }
      }

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

      const mergedAIChats = [...(existingBook.aiChats || [])];
      if (backupBook.aiChats) {
        for (const c of backupBook.aiChats) {
          const isDuplicate = mergedAIChats.some(ex => ex.chatId === c.chatId);
          if (!isDuplicate) {
            mergedAIChats.push(c);
          }
        }
      }

      let mergedStats = null;
      if (existingBook.stats || backupBook.stats) {
        const eStats = existingBook.stats || { totalTime: 0, readingDays: {}, hourlyDist: {} };
        const bStats = backupBook.stats || { totalTime: 0, readingDays: {}, hourlyDist: {} };
        const allDays = new Set([...Object.keys(eStats.readingDays || {}), ...Object.keys(bStats.readingDays || {})]);
        const mergedReadingDays = {};
        for (const day of allDays) {
          mergedReadingDays[day] = Math.max(eStats.readingDays?.[day] || 0, bStats.readingDays?.[day] || 0);
        }

        const mergedHourlyDist = {};
        for (let h = 0; h < 24; h++) {
          mergedHourlyDist[h] = Math.max(eStats.hourlyDist?.[h] || 0, bStats.hourlyDist?.[h] || 0);
        }

        mergedStats = {
          totalTime: Math.max(eStats.totalTime || 0, bStats.totalTime || 0),
          readingDays: mergedReadingDays,
          hourlyDist: mergedHourlyDist
        };
      }

      mergedBook = {
        ...existingBook,
        file: backupBook.file || existingBook.file,
        cover: backupBook.cover || existingBook.cover,
        size: backupBook.size || existingBook.size,
        progress: mergedProgress,
        bookmarks: mergedBookmarks,
        notes: mergedNotes,
        aiChats: mergedAIChats,
        lastReadAt: Math.max(existingLastRead, backupLastRead),
        stats: mergedStats,
        bookSummary: existingBook.bookSummary || backupBook.bookSummary || '',
        chapterSummaries: { ...(existingBook.chapterSummaries || {}), ...(backupBook.chapterSummaries || {}) }
      };
    } else {
      mergedBook = backupBook;
    }

    let cleanFile = mergedBook.file;
    if (cleanFile && typeof File !== 'undefined' && cleanFile instanceof File) {
      cleanFile = new Blob([cleanFile], { type: cleanFile.type });
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books', 'book_files'], 'readwrite');
      const store = transaction.objectStore('books');
      const fileStore = transaction.objectStore('book_files');

      store.put(this._cleanBookForStorage(mergedBook));
      if (cleanFile) {
        fileStore.put({ id: mergedBook.id, file: cleanFile });
      }

      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // 獲取所有書籍 (按最後閱讀時間，再按新增時間排序)
  // options.includeFiles: true 時加載檔案 Blob（備份導出時使用）；預設 false 不加載大文件以節省內存
  async getAllBooks(options = {}) {
    await this._ensureOpen();
    const includeFiles = options && options.includeFiles === true;

    return new Promise((resolve, reject) => {
      const transaction = includeFiles 
        ? this.db.transaction(['books', 'book_files'], 'readonly')
        : this.db.transaction(['books'], 'readonly');
      const store = transaction.objectStore('books');
      const request = store.getAll();

      request.onsuccess = async () => {
        const books = request.result || [];
        books.sort((a, b) => {
          if (b.lastReadAt !== a.lastReadAt) {
            return b.lastReadAt - a.lastReadAt;
          }
          return b.addedAt - a.addedAt;
        });

        if (includeFiles) {
          const fileStore = transaction.objectStore('book_files');
          const fileRecords = await new Promise(res => {
            const fReq = fileStore.getAll();
            fReq.onsuccess = () => res(fReq.result || []);
            fReq.onerror = () => res([]);
          });
          const fileMap = new Map(fileRecords.map(f => [f.id, f.file]));
          books.forEach(b => {
            b.file = fileMap.get(b.id) || null;
          });
        }

        resolve(books);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // 獲取單本書籍（包含檔案與元數據，供閱讀器打開閱讀）
  async getBook(id) {
    await this._ensureOpen();
    const meta = await this.getBookMetadata(id);
    if (!meta) return null;

    const fileRecord = await this.getBookFile(id);
    return {
      ...meta,
      file: fileRecord ? fileRecord.file : null
    };
  }

  // 獲取單本書籍純元數據（極速，不載入大文件）
  async getBookMetadata(id) {
    await this._ensureOpen();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books'], 'readonly');
      const store = transaction.objectStore('books');
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // 獲取單本書籍原始二進制檔案
  async getBookFile(id) {
    await this._ensureOpen();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['book_files'], 'readonly');
      const store = transaction.objectStore('book_files');
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // 刪除書籍 (同時刪除元數據與實體檔案)
  async deleteBook(id) {
    await this._ensureOpen();
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books', 'book_files'], 'readwrite');
      transaction.objectStore('books').delete(id);
      transaction.objectStore('book_files').delete(id);

      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // 核心安全元數據變更器 (帶排隊保護，保證在併發寫入時讀取最新元數據，防止進度與統計互相覆蓋)
  async _mutateBook(id, mutatorFn) {
    if (!this._progressQueue) {
      this._progressQueue = Promise.resolve();
    }

    const task = async () => {
      await this._ensureOpen();
      const book = await this.getBookMetadata(id);
      if (!book) return null;

      const result = await mutatorFn(book);
      book.lastReadAt = Date.now();

      return new Promise((resolve) => {
        const transaction = this.db.transaction(['books'], 'readwrite');
        const store = transaction.objectStore('books');
        const request = store.put(this._cleanBookForStorage(book));

        transaction.oncomplete = () => resolve(result !== undefined ? result : book);
        transaction.onerror = () => {
          console.warn('[BookLibrary] _mutateBook transaction error:', transaction.error || request.error);
          resolve(result !== undefined ? result : book);
        };
        transaction.onabort = () => {
          console.warn('[BookLibrary] _mutateBook transaction aborted');
          resolve(result !== undefined ? result : book);
        };
      });
    };

    this._progressQueue = this._progressQueue.then(task).catch(err => {
      console.warn('[BookLibrary] _mutateBook queue error:', err);
      return null;
    });

    return this._progressQueue;
  }

  // 更新閱讀進度 (帶排隊保護，僅更新元數據，絕不重寫 50MB 檔案本體)
  async updateProgress(id, progressUpdate) {
    return this._mutateBook(id, (book) => {
      book.progress = { ...book.progress, ...progressUpdate };
      return book.progress;
    });
  }

  // 更新書籍封面 (僅更新元數據)
  async updateBookCover(id, cover) {
    return this._mutateBook(id, (book) => {
      book.cover = cover;
      return book;
    });
  }

  // 更新書籍資料夾 (僅更新元數據)
  async updateBookFolder(id, folder) {
    return this._mutateBook(id, (book) => {
      book.folder = folder;
      return book;
    });
  }

  // 保存或更新高亮筆記 (僅更新元數據)
  async saveNote(id, note) {
    return this._mutateBook(id, (book) => {
      if (!book.notes) book.notes = [];
      const existingIndex = book.notes.findIndex(n => n.noteId === note.noteId);
      if (existingIndex > -1) {
        book.notes[existingIndex] = { ...book.notes[existingIndex], ...note };
      } else {
        book.notes.push({
          noteId: note.noteId || 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
          createdAt: Date.now(),
          ...note
        });
      }
      return book.notes;
    });
  }

  // 刪除高亮筆記 (僅更新元數據)
  async deleteNote(id, noteId) {
    return this._mutateBook(id, (book) => {
      if (book.notes) {
        book.notes = book.notes.filter(n => n.noteId !== noteId);
      }
      return book.notes || [];
    });
  }

  // 保存書籤 (僅更新元數據)
  async saveBookmark(id, bookmark) {
    return this._mutateBook(id, (book) => {
      if (!book.bookmarks) book.bookmarks = [];
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
      return book.bookmarks;
    });
  }

  // 刪除書籤 (僅更新元數據)
  async deleteBookmark(id, bookmarkId) {
    return this._mutateBook(id, (book) => {
      if (book.bookmarks) {
        book.bookmarks = book.bookmarks.filter(b => b.bookmarkId !== bookmarkId);
      }
      return book.bookmarks || [];
    });
  }

  // 累加閱讀統計資訊 (帶排隊保護，防禦性欄位校驗，保證統計永久可靠)
  async addReadingDuration(id, seconds) {
    if (!seconds || seconds <= 0) return null;
    return this._mutateBook(id, (book) => {
      if (!book.stats || typeof book.stats !== 'object') {
        book.stats = {
          totalTime: 0,
          readingDays: {},
          hourlyDist: {}
        };
      }
      if (!book.stats.readingDays || typeof book.stats.readingDays !== 'object') {
        book.stats.readingDays = {};
      }
      if (!book.stats.hourlyDist || typeof book.stats.hourlyDist !== 'object') {
        book.stats.hourlyDist = {};
      }

      const now = new Date();
      const dateStr = now.getFullYear() + '-' + 
                      String(now.getMonth() + 1).padStart(2, '0') + '-' + 
                      String(now.getDate()).padStart(2, '0');
      const hour = now.getHours();

      book.stats.totalTime = (Number(book.stats.totalTime) || 0) + seconds;
      book.stats.readingDays[dateStr] = (Number(book.stats.readingDays[dateStr]) || 0) + seconds;
      book.stats.hourlyDist[hour] = (Number(book.stats.hourlyDist[hour]) || 0) + seconds;

      return book;
    });
  }

  // 清理單本書籍的閱讀統計 (帶排隊保護)
  async clearBookStats(id) {
    return this._mutateBook(id, (book) => {
      book.stats = {
        totalTime: 0,
        readingDays: {},
        hourlyDist: {}
      };
      return book;
    });
  }

  // 清理所有書籍的閱讀統計
  async clearAllStats() {
    await this._ensureOpen();
    const books = await this.getAllBooks();
    if (!books || books.length === 0) return true;

    for (const book of books) {
      await this.clearBookStats(book.id);
    }
    return true;
  }

  // 保存 AI 溝通記錄 (帶排隊保護)
  async saveAIChat(id, chat) {
    return this._mutateBook(id, (book) => {
      if (!book.aiChats) book.aiChats = [];
      book.aiChats.push({
        chatId: chat.chatId || 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        createdAt: Date.now(),
        query: chat.query,
        reply: chat.reply
      });
      return book.aiChats;
    });
  }

  // 刪除單一 AI 溝通記錄 (帶排隊保護)
  async deleteAIChat(id, chatId) {
    return this._mutateBook(id, (book) => {
      if (book.aiChats) {
        book.aiChats = book.aiChats.filter(c => c.chatId !== chatId);
      }
      return book.aiChats || [];
    });
  }

  // 清除全部 AI 溝通記錄 (帶排隊保護)
  async clearAllAIChats(id) {
    return this._mutateBook(id, (book) => {
      book.aiChats = [];
      return book.aiChats;
    });
  }

  // 保存全書深度分析摘要 (帶排隊保護)
  async saveBookSummary(id, summary) {
    return this._mutateBook(id, (book) => {
      book.bookSummary = summary;
      return book.bookSummary;
    });
  }

  // 保存單個章節的摘要 (帶排隊保護)
  async saveChapterSummary(id, index, summary) {
    return this._mutateBook(id, (book) => {
      if (!book.chapterSummaries) book.chapterSummaries = {};
      book.chapterSummaries[index] = summary;
      return book.chapterSummaries;
    });
  }
}
