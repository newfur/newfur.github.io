// reader/sync.js
// Edge-Reader WebDAV 多端同步核心服务
// 支持本地离线 / WebDAV 远程无缝切换、差量双向同步、阅读进度防零覆盖与划线笔记合并

import { WebDAVClient } from './webdav.js';

export class SyncManager {
  constructor(library) {
    this.library = library;
    this.client = null;
    this.state = 'idle'; // 'idle' | 'syncing' | 'success' | 'error' | 'offline'
    this.lastError = null;
    this.lastSyncTime = 0;
    this.listeners = new Set();
    this._syncLock = false;
    this._progressDebounceTimers = new Map();

    // 默认配置
    this.config = {
      storageMode: 'local', // 'local' | 'webdav'
      endpoint: '',
      username: '',
      password: '',
      remotePath: '/EdgeReader',
      syncMode: 'all', // 'all' (图书与记录完整同步) | 'records_only' (仅轻量记录与配置)
      autoSyncOnOpen: true,
      autoSyncOnProgress: true
    };
  }

  // 注册状态监听器（UI 组件响应）
  addListener(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  // 广播状态更新
  _setState(state, err = null) {
    this.state = state;
    this.lastError = err;
    const info = {
      state: this.state,
      lastError: this.lastError,
      lastSyncTime: this.lastSyncTime,
      storageMode: this.config.storageMode
    };
    for (const cb of this.listeners) {
      try {
        cb(info);
      } catch (e) {
        console.warn('[SyncManager] Listener error:', e);
      }
    }
  }

  // 初始化加载配置
  async init() {
    await this.loadConfig();
    this._initClient();

    // 加载上次同步时间
    try {
      const savedTime = localStorage.getItem('edgereader_last_sync_time');
      if (savedTime) {
        this.lastSyncTime = parseInt(savedTime, 10) || 0;
      }
    } catch (e) {}

    // 若启用了 WebDAV 且开启了启动时自动同步，延时触发静默同步
    if (this.isWebDAVEnabled() && this.config.autoSyncOnOpen) {
      setTimeout(() => {
        this.syncAll({ silent: true }).catch(err => {
          console.warn('[SyncManager] Auto sync on open failed:', err);
        });
      }, 1500);
    }
  }

  // 判断 WebDAV 是否配置完整且启用
  isWebDAVEnabled() {
    return this.config.storageMode === 'webdav' && Boolean(this.config.endpoint && this.client);
  }

  // 根据当前配置实例化 WebDAV 客户端
  _initClient() {
    if (this.config.endpoint) {
      this.client = new WebDAVClient({
        endpoint: this.config.endpoint,
        username: this.config.username,
        password: this.config.password,
        remotePath: this.config.remotePath || '/EdgeReader'
      });
    } else {
      this.client = null;
    }
  }

  // 读取配置
  async loadConfig() {
    return new Promise((resolve) => {
      // 优先从 chrome.storage.local 读取，降级从 localStorage 读取
      const fallbackLoad = () => {
        try {
          const raw = localStorage.getItem('edgereader_sync_config');
          if (raw) {
            const parsed = JSON.parse(raw);
            this.config = { ...this.config, ...parsed };
          }
        } catch (e) {}
        this._initClient();
        resolve(this.config);
      };

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['syncConfig'], (res) => {
          if (res && res.syncConfig) {
            this.config = { ...this.config, ...res.syncConfig };
            this._initClient();
            resolve(this.config);
          } else {
            fallbackLoad();
          }
        });
      } else {
        fallbackLoad();
      }
    });
  }

  // 保存配置
  async saveConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this._initClient();

    try {
      localStorage.setItem('edgereader_sync_config', JSON.stringify(this.config));
    } catch (e) {}

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await new Promise(res => {
        chrome.storage.local.set({ syncConfig: this.config }, res);
      });
    }

    this._setState(this.state);
    return this.config;
  }

  // 测试 WebDAV 连通性
  async testConnection(customConfig = null) {
    const cfg = customConfig ? { ...this.config, ...customConfig } : this.config;
    const testClient = new WebDAVClient({
      endpoint: cfg.endpoint,
      username: cfg.username,
      password: cfg.password,
      remotePath: cfg.remotePath || '/EdgeReader'
    });
    return testClient.testConnection();
  }

  // 确保远端标准目录骨架就绪
  async _ensureRemoteDirectories() {
    if (!this.client) throw new Error('WebDAV client not initialized');
    await this.client.ensureDir('');
    await this.client.ensureDir('config');
    await this.client.ensureDir('records');
    if (this.config.syncMode === 'all') {
      await this.client.ensureDir('books');
      await this.client.ensureDir('covers');
    }
  }

  // 获取本地墓碑列表（已删除的书籍 ID）
  _getDeletedBookIds() {
    const list = new Set();
    try {
      const raw = localStorage.getItem('edgereader_deleted_book_ids');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach(id => list.add(String(id)));
      }
    } catch (e) {}
    // 汇总 library 中的待清理列表
    if (this.library && this.library._deletedBookIds) {
      for (const id of this.library._deletedBookIds) {
        list.add(String(id));
      }
    }
    return list;
  }

  // 记录删除墓碑
  _recordDeletedBookId(bookId) {
    const idStr = String(bookId);
    const list = this._getDeletedBookIds();
    list.add(idStr);
    try {
      localStorage.setItem('edgereader_deleted_book_ids', JSON.stringify(Array.from(list)));
    } catch (e) {}
  }

  // 异步删除远端书籍并记录墓碑
  async handleDeleteBook(bookId) {
    this._recordDeletedBookId(bookId);
    if (!this.isWebDAVEnabled()) return;

    try {
      // 异步清理远端文件，不阻塞本地用户体验
      this.client.deleteFile(`records/book_${bookId}.json`).catch(() => {});
      this.client.deleteFile(`books/${bookId}.bin`).catch(() => {});
      this.client.deleteFile(`covers/${bookId}.bin`).catch(() => {});

      // 同步更新远端墓碑清单
      const manifest = (await this.client.getFile('records/sync_manifest.json', 'json')) || {
        version: '1.0', updatedAt: Date.now(), deletedBookIds: []
      };
      if (!Array.isArray(manifest.deletedBookIds)) manifest.deletedBookIds = [];
      if (!manifest.deletedBookIds.includes(String(bookId))) {
        manifest.deletedBookIds.push(String(bookId));
        manifest.updatedAt = Date.now();
        await this.client.putFile('records/sync_manifest.json', manifest);
      }
    } catch (e) {
      console.warn('[SyncManager] Failed to sync deleted book to WebDAV:', e);
    }
  }

  // 高频防抖：当单本书籍阅读进度发生变化时快速推送（仅 2KB 轻量包）
  triggerProgressSync(bookId, bookData = null) {
    if (!this.isWebDAVEnabled() || !this.config.autoSyncOnProgress) return;

    // 清除已有定时器
    if (this._progressDebounceTimers.has(bookId)) {
      clearTimeout(this._progressDebounceTimers.get(bookId));
    }

    const timer = setTimeout(async () => {
      this._progressDebounceTimers.delete(bookId);
      try {
        await this.syncSingleBookRecord(bookId, bookData);
      } catch (err) {
        console.warn(`[SyncManager] Background sync for book ${bookId} failed:`, err);
      }
    }, 2500); // 2.5 秒防抖

    this._progressDebounceTimers.set(bookId, timer);
  }

  // 上传单本书籍的轻量阅读记录 (records/book_{id}.json)
  async syncSingleBookRecord(bookId, bookData = null) {
    if (!this.client) return;
    let book = bookData;
    if (!book) {
      book = await this.library.getBookMetadata(bookId);
    }
    if (!book) return;

    // 获取本地最新的瞬时进度
    let progress = book.progress || null;
    try {
      const rawProg = localStorage.getItem('progress_' + book.id);
      if (rawProg) {
        progress = { ...(progress || {}), ...JSON.parse(rawProg) };
      }
    } catch (e) {}

    const payload = {
      id: book.id,
      title: book.title || '',
      author: book.author || '',
      format: book.format || '',
      size: book.size || 0,
      addedAt: book.addedAt || Date.now(),
      lastReadAt: book.lastReadAt || Date.now(),
      recordUpdatedAt: Date.now(),
      progress,
      bookmarks: book.bookmarks || [],
      notes: book.notes || [],
      stats: book.stats || { totalTime: 0, readingDays: {}, hourlyDist: {} },
      aiChats: book.aiChats || [],
      bookSummary: book.bookSummary || '',
      chapterSummaries: book.chapterSummaries || {},
      folder: book.folder || null
    };

    await this.client.putFile(`records/book_${book.id}.json`, payload);
  }

  // 同步用户全局设置与自定义数据 (config/settings.json)
  async syncSettings() {
    if (!this.client) return;

    const localSettings = {
      updatedAt: Date.now(),
      theme: null,
      customFolders: null,
      aiPromptsTemplates: null,
      coverWidth: localStorage.getItem('coverWidth') || '180',
      ttsProvider: localStorage.getItem('ttsProvider') || 'edge'
    };

    try {
      const rawTheme = localStorage.getItem('theme');
      if (rawTheme) localSettings.theme = JSON.parse(rawTheme);
    } catch (e) {}

    try {
      const rawFolders = localStorage.getItem('custom_folders');
      if (rawFolders) localSettings.customFolders = JSON.parse(rawFolders);
    } catch (e) {}

    // 读取远端设置
    let remoteSettings = null;
    try {
      remoteSettings = await this.client.getFile('config/settings.json', 'json');
    } catch (e) {}

    if (remoteSettings && remoteSettings.updatedAt > localSettings.updatedAt) {
      // 远端更新，应用到本地
      if (remoteSettings.theme && typeof remoteSettings.theme === 'object') {
        localStorage.setItem('theme', JSON.stringify(remoteSettings.theme));
      }
      if (Array.isArray(remoteSettings.customFolders)) {
        localStorage.setItem('custom_folders', JSON.stringify(remoteSettings.customFolders));
      }
      if (remoteSettings.coverWidth) {
        localStorage.setItem('coverWidth', remoteSettings.coverWidth);
      }
    } else {
      // 本地推送至远端
      await this.client.putFile('config/settings.json', localSettings);
    }
  }

  // 执行全量双向增量同步 (Sync All)
  async syncAll(options = {}) {
    if (!this.isWebDAVEnabled()) {
      if (!options.silent) {
        throw new Error('未配置或未启用 WebDAV 远程存储模式');
      }
      return;
    }

    if (this._syncLock) {
      console.log('[SyncManager] Sync is already in progress, skipping...');
      return;
    }

    this._syncLock = true;
    this._setState('syncing');

    try {
      // 1. 确保远端基础目录存在
      await this._ensureRemoteDirectories();

      // 2. 双向同步配置
      try {
        await this.syncSettings();
      } catch (cfgErr) {
        console.warn('[SyncManager] Settings sync failed, continuing:', cfgErr);
      }

      // 3. 读取远端清单与墓碑合并
      let manifest = null;
      try {
        manifest = await this.client.getFile('records/sync_manifest.json', 'json');
      } catch (e) {}

      if (!manifest || typeof manifest !== 'object') {
        manifest = { version: '1.0', updatedAt: 0, deletedBookIds: [] };
      }
      if (!Array.isArray(manifest.deletedBookIds)) {
        manifest.deletedBookIds = [];
      }

      const localDeletedIds = this._getDeletedBookIds();
      // 合并墓碑
      for (const id of manifest.deletedBookIds) {
        localDeletedIds.add(String(id));
      }
      for (const id of localDeletedIds) {
        if (!manifest.deletedBookIds.includes(String(id))) {
          manifest.deletedBookIds.push(String(id));
        }
      }

      // 4. 清理本地与远端在墓碑中的书籍
      for (const deletedId of localDeletedIds) {
        try {
          await this.library.deleteBook(deletedId);
        } catch (e) {}
      }

      // 5. 获取本地所有书籍元数据
      const localBooks = await this.library.getAllBooks({ includeFiles: false });
      const localBookMap = new Map(localBooks.map(b => [String(b.id), b]));

      // 6. 获取远端书库索引 (library.json)
      let remoteLibrary = null;
      try {
        remoteLibrary = await this.client.getFile('library.json', 'json');
      } catch (e) {}

      if (!remoteLibrary || !Array.isArray(remoteLibrary.books)) {
        remoteLibrary = { version: '1.0', updatedAt: 0, books: [] };
      }
      const remoteBookMap = new Map(remoteLibrary.books.map(b => [String(b.id), b]));

      // 7. 处理远端有、本地没有的书籍 (远端 -> 本地)
      for (const [remoteId, remoteMeta] of remoteBookMap.entries()) {
        if (localDeletedIds.has(remoteId)) continue;
        if (!localBookMap.has(remoteId)) {
          // 下载远端阅读记录
          let remoteRecord = null;
          try {
            remoteRecord = await this.client.getFile(`records/book_${remoteId}.json`, 'json');
          } catch (e) {}

          const mergedMeta = { ...remoteMeta, ...(remoteRecord || {}) };

          // 若开启了完整同步模式，尝试拉取书籍文件与封面
          if (this.config.syncMode === 'all') {
            let fileBlob = null;
            let coverBlob = null;
            try {
              fileBlob = await this.client.getFile(`books/${remoteId}.bin`, 'blob');
            } catch (fErr) {
              console.warn(`[SyncManager] Failed to fetch book binary for ${remoteId}:`, fErr);
            }
            try {
              coverBlob = await this.client.getFile(`covers/${remoteId}.bin`, 'blob');
            } catch (cErr) {}

            mergedMeta.file = fileBlob;
            if (coverBlob) mergedMeta.cover = coverBlob;
          }

          // 导入本地书库
          await this.library.importBook(mergedMeta);
        }
      }

      // 8. 处理本地有、远端没有的书籍 (本地 -> 远端)
      for (const [localId, localBook] of localBookMap.entries()) {
        if (localDeletedIds.has(localId)) continue;
        if (!remoteBookMap.has(localId)) {
          // 上传轻量阅读记录
          await this.syncSingleBookRecord(localId, localBook);

          // 若处于完整同步模式，上传书籍二进制和封面
          if (this.config.syncMode === 'all') {
            try {
              const fullBook = await this.library.getBook(localId);
              if (fullBook && fullBook.file) {
                await this.client.putFile(`books/${localId}.bin`, fullBook.file);
              }
              if (localBook.cover && localBook.cover instanceof Blob) {
                await this.client.putFile(`covers/${localId}.bin`, localBook.cover);
              }
            } catch (upErr) {
              console.warn(`[SyncManager] Failed to upload binary for book ${localId}:`, upErr);
            }
          }
        }
      }

      // 9. 处理两端皆有的书籍 (双向差量 Smart Merge)
      for (const [id, localBook] of localBookMap.entries()) {
        if (localDeletedIds.has(id)) continue;
        const remoteMeta = remoteBookMap.get(id);
        if (!remoteMeta) continue;

        // 获取两端的记录时间戳进行比对
        let remoteRecord = null;
        try {
          remoteRecord = await this.client.getFile(`records/book_${id}.json`, 'json');
        } catch (e) {}

        if (remoteRecord) {
          const localLastRead = Number(localBook.lastReadAt) || 0;
          const remoteLastRead = Number(remoteRecord.lastReadAt) || 0;
          const remoteRecordUpdated = Number(remoteRecord.recordUpdatedAt) || remoteLastRead;

          // 若远端更新，拉取并合并至本地
          if (remoteRecordUpdated > localLastRead) {
            await this.library.importBook({
              ...localBook,
              ...remoteRecord,
              id
            });
          } else if (localLastRead > remoteRecordUpdated) {
            // 本地更新，推送到远端
            await this.syncSingleBookRecord(id, localBook);
          }
        }
      }

      // 10. 更新最新的远端书库索引与清单
      const refreshedLocalBooks = await this.library.getAllBooks({ includeFiles: false });
      const cleanIndexList = refreshedLocalBooks.map(b => ({
        id: b.id,
        title: b.title,
        author: b.author,
        format: b.format,
        size: b.size,
        addedAt: b.addedAt,
        lastReadAt: b.lastReadAt,
        folder: b.folder || null
      }));

      await this.client.putFile('library.json', {
        version: '1.0',
        updatedAt: Date.now(),
        books: cleanIndexList
      });

      manifest.updatedAt = Date.now();
      await this.client.putFile('records/sync_manifest.json', manifest);

      // 11. 记录同步成功状态
      this.lastSyncTime = Date.now();
      try {
        localStorage.setItem('edgereader_last_sync_time', String(this.lastSyncTime));
      } catch (e) {}

      this._setState('success');
      return { success: true, count: cleanIndexList.length };
    } catch (err) {
      console.error('[SyncManager] Sync failed:', err);
      this._setState('error', err.message || String(err));
      if (!options.silent) throw err;
    } finally {
      this._syncLock = false;
    }
  }
}
