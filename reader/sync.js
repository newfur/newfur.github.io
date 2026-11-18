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

    this.remoteBookCache = {
      updatedAt: 0,
      books: {}
    };
    this._currentlySyncingBookId = null;

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

    // 立即从 localStorage 同步预加载配置与缓存（规避页面初始化/刷新时的异步竞态时序差，确保卡片初次渲染即刻显示徽章）
    try {
      if (typeof localStorage !== 'undefined') {
        const rawCfg = localStorage.getItem('edgereader_sync_config');
        if (rawCfg) {
          const parsed = JSON.parse(rawCfg);
          if (parsed && typeof parsed === 'object') {
            this.config = { ...this.config, ...parsed };
            this._initClient();
          }
        }

        const savedCache = localStorage.getItem('edgereader_remote_books_cache');
        if (savedCache) {
          const parsed = JSON.parse(savedCache);
          if (parsed && typeof parsed.books === 'object') {
            this.remoteBookCache = parsed;
          }
        }

        const savedTime = localStorage.getItem('edgereader_last_sync_time');
        if (savedTime) {
          this.lastSyncTime = parseInt(savedTime, 10) || 0;
        }
      }
    } catch (e) {}
  }

  // 注册状态监听器（UI 组件响应）
  addListener(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  // 广播状态更新
  _setState(state, err = null, extra = {}) {
    this.state = state;
    this.lastError = err;
    const info = {
      state: this.state,
      lastError: this.lastError,
      lastSyncTime: this.lastSyncTime,
      storageMode: this.config.storageMode,
      ...extra
    };
    for (const cb of this.listeners) {
      try {
        cb(info);
      } catch (e) {
        console.log('[SyncManager] Listener error:', e);
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

    // 加载远端图书同步状态缓存
    try {
      const savedCache = localStorage.getItem('edgereader_remote_books_cache');
      if (savedCache) {
        const parsed = JSON.parse(savedCache);
        if (parsed && typeof parsed.books === 'object') {
          this.remoteBookCache = parsed;
        }
      }
    } catch (e) {}

    // 状态广播，通知各监听器（如顶部同步按钮可见性、书架徽章等）当前存储模式与状态就绪
    this._setState(this.state);

    // 若启用了 WebDAV 且开启了启动时自动同步，延时触发静默轻量记录同步
    if (this.isWebDAVEnabled() && this.config.autoSyncOnOpen) {
      // 防崩溃死循环熔断保护 (Circuit Breaker)：
      // 如果 45 秒内刚刚发生过未完成的同步尝试（例如系统因 OOM 强杀或异常崩溃刷新），跳过本次自动同步，杜绝无限刷新闪退
      let lastAttempt = 0;
      try {
        lastAttempt = Number(sessionStorage.getItem('edgereader_sync_attempt_time') || 0);
      } catch (e) {}

      const now = Date.now();
      if (now - lastAttempt < 45000) {
        console.log('[SyncManager] Previous sync attempted less than 45s ago, skipping auto-sync on open to prevent reload loop');
        return;
      }

      setTimeout(() => {
        // 启动时仅执行轻量级记录与元数据同步（recordsOnly: true），零内存压力，毫秒级完成
        this.syncAll({ silent: true, recordsOnly: true }).catch(err => {
          console.log('[SyncManager] Auto sync on open note:', err?.message || err);
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
      // 将清洗后的规范化配置回写，防止凭据中含有非法空白字符或 URL 嵌入式密码
      if (this.client.endpoint) this.config.endpoint = this.client.endpoint;
      if (this.client.username) this.config.username = this.client.username;
      if (this.client.password) this.config.password = this.client.password;
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
          if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem('edgereader_sync_config');
            if (raw) {
              const parsed = JSON.parse(raw);
              this.config = { ...this.config, ...parsed };
            }
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
            try {
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem('edgereader_sync_config', JSON.stringify(this.config));
              }
            } catch (e) {}
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

  // 保存配置（自动清洗首尾空白与特殊字符）
  async saveConfig(newConfig) {
    const cleanConfig = { ...newConfig };
    if (typeof cleanConfig.endpoint === 'string') cleanConfig.endpoint = cleanConfig.endpoint.trim();
    if (typeof cleanConfig.username === 'string') cleanConfig.username = cleanConfig.username.trim();
    if (typeof cleanConfig.password === 'string') cleanConfig.password = cleanConfig.password.trim();
    if (typeof cleanConfig.remotePath === 'string') cleanConfig.remotePath = cleanConfig.remotePath.trim();

    this.config = { ...this.config, ...cleanConfig };
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
    await this.client.ensureDir('covers'); // 封面目录始终就绪，确保任意模式下均能全量双向同步封面
    if (this.config.syncMode === 'all') {
      await this.client.ensureDir('books');
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
      console.log('[SyncManager] Failed to sync deleted book to WebDAV:', e);
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
        console.log(`[SyncManager] Background sync for book ${bookId} failed:`, err);
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

    let localUpdatedAt = 0;
    try {
      localUpdatedAt = parseInt(localStorage.getItem('edgereader_settings_updated_at') || '0', 10);
    } catch (_) {}

    const localSettings = {
      version: '1.0',
      updatedAt: localUpdatedAt || Date.now(),
      theme: null,
      customFolders: null,
      deletedFolders: [],
      aiPromptsTemplates: null,
      coverWidth: localStorage.getItem('coverWidth') || '180',
      ttsProvider: localStorage.getItem('ttsProvider') || 'edge'
    };

    try {
      const rawTheme = localStorage.getItem('theme');
      if (rawTheme) localSettings.theme = JSON.parse(rawTheme);
    } catch (e) {}

    try {
      const rawFolders = localStorage.getItem('edgereader_custom_folders') || localStorage.getItem('custom_folders');
      if (rawFolders) localSettings.customFolders = JSON.parse(rawFolders);
    } catch (e) {}

    try {
      const rawDeleted = localStorage.getItem('edgereader_deleted_folders');
      if (rawDeleted) localSettings.deletedFolders = JSON.parse(rawDeleted);
    } catch (e) {}
    if (!Array.isArray(localSettings.deletedFolders)) localSettings.deletedFolders = [];

    // 读取远端设置
    let remoteSettings = null;
    try {
      remoteSettings = await this.client.getFile('config/settings.json', 'json');
    } catch (e) {}

    if (remoteSettings && typeof remoteSettings === 'object') {
      const remoteUpdatedAt = Number(remoteSettings.updatedAt) || 0;
      const remoteDeletedFolders = Array.isArray(remoteSettings.deletedFolders) ? remoteSettings.deletedFolders : [];

      // 1. 双向合并已删除文件夹墓碑列表，确保任意设备删除的文件夹在所有设备上都不会被复活
      const mergedDeletedFolders = Array.from(new Set([...localSettings.deletedFolders, ...remoteDeletedFolders]));
      localStorage.setItem('edgereader_deleted_folders', JSON.stringify(mergedDeletedFolders));
      localSettings.deletedFolders = mergedDeletedFolders;

      // 2. 根据时间戳权威裁决
      if (remoteUpdatedAt > localUpdatedAt) {
        // 远端更新，应用到本地
        if (remoteSettings.theme && typeof remoteSettings.theme === 'object') {
          localStorage.setItem('theme', JSON.stringify(remoteSettings.theme));
        }
        if (Array.isArray(remoteSettings.customFolders)) {
          // 过滤掉墓碑中的已删除文件夹
          const cleanRemoteFolders = remoteSettings.customFolders.filter(f => !mergedDeletedFolders.includes(f));
          localStorage.setItem('edgereader_custom_folders', JSON.stringify(cleanRemoteFolders));
          localStorage.setItem('custom_folders', JSON.stringify(cleanRemoteFolders));
        }
        if (remoteSettings.coverWidth) {
          localStorage.setItem('coverWidth', remoteSettings.coverWidth);
        }
        localStorage.setItem('edgereader_settings_updated_at', String(remoteUpdatedAt));
      } else {
        // 本地更新（本地创建、重命名或删除文件夹后更新了时间戳，本地为最新权威状态）
        const localFoldersList = Array.isArray(localSettings.customFolders) ? localSettings.customFolders : [];
        const cleanLocalFolders = localFoldersList.filter(f => !mergedDeletedFolders.includes(f));
        localSettings.customFolders = cleanLocalFolders;
        localStorage.setItem('edgereader_custom_folders', JSON.stringify(cleanLocalFolders));
        localStorage.setItem('custom_folders', JSON.stringify(cleanLocalFolders));
        await this.client.putFile('config/settings.json', localSettings);
      }
    } else {
      // 远端不存在，直接上传本地设置
      await this.client.putFile('config/settings.json', localSettings);
    }
  }

  // 保存远端图书状态缓存
  _saveRemoteBookCache() {
    try {
      this.remoteBookCache.updatedAt = Date.now();
      localStorage.setItem('edgereader_remote_books_cache', JSON.stringify(this.remoteBookCache));
    } catch (e) {}
  }

  // 更新某本书在远端缓存中的状态
  _updateRemoteBookCache(bookId, partialData) {
    const id = String(bookId);
    if (!this.remoteBookCache.books) this.remoteBookCache.books = {};
    const existing = this.remoteBookCache.books[id] || { id, hasRecord: false, hasBinary: false, size: 0 };
    this.remoteBookCache.books[id] = { ...existing, ...partialData, updatedAt: Date.now() };
    this._saveRemoteBookCache();
  }

  // 将封面（无论 Blob 还是 DataURL 字符串）统一无损转换为 Blob，确保可上传至 WebDAV
  _coverToBlob(cover) {
    if (!cover) return null;
    if (typeof Blob !== 'undefined' && cover instanceof Blob) {
      return cover;
    }
    if (typeof cover === 'object' && cover && typeof cover.size === 'number' && typeof cover.slice === 'function') {
      return cover;
    }
    if (typeof cover === 'string' && cover.startsWith('data:')) {
      try {
        const parts = cover.split(',');
        const mimeMatch = parts[0].match(/:(.*?);/);
        const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
        const base64Data = parts[1];
        let binaryStr;
        if (typeof atob === 'function') {
          binaryStr = atob(base64Data);
        } else if (typeof Buffer !== 'undefined') {
          binaryStr = Buffer.from(base64Data, 'base64').toString('binary');
        } else {
          return null;
        }
        const len = binaryStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        if (typeof Blob !== 'undefined') {
          return new Blob([bytes], { type: mime });
        }
        return bytes;
      } catch (e) {
        console.log('[SyncManager] Failed to convert cover DataURL to Blob:', e);
        return null;
      }
    }
    return null;
  }

  // 获取单本书的同步状态
  // 返回: null (未启用 WebDAV) | { status: 'syncing' | 'synced' | 'local_only' | 'cloud_only', label: string }
  getBookSyncStatus(bookId, localBook = null) {
    if (!this.isWebDAVEnabled()) return null;
    const id = String(bookId);

    // 正在同步中
    if (this._currentlySyncingBookId === id) {
      return { status: 'syncing', label: '正在同步...' };
    }

    const remoteInfo = this.remoteBookCache?.books?.[id];
    const isDeleted = Boolean(this.library && this.library._deletedBookIds?.has(id));
    if (isDeleted) return null;

    const hasLocal = Boolean(localBook || (this.library && !this.library._deletedBookIds?.has(id)));

    // 检查本地是否存在实体文件
    let hasLocalFile = true;
    if (localBook) {
      if (typeof localBook.hasLocalFile === 'boolean') {
        hasLocalFile = localBook.hasLocalFile;
      } else if (localBook.file !== undefined) {
        hasLocalFile = Boolean(localBook.file);
      }
    }

    if (remoteInfo) {
      if (remoteInfo.hasBinary) {
        if (hasLocal && !hasLocalFile) {
          return { status: 'cloud_only', label: '云端书籍 (待下载)' };
        }
        return { status: 'synced', label: '已同步云端' };
      }
      if (hasLocal) {
        if (!hasLocalFile) {
          return { status: 'cloud_only', label: '云端书籍 (待下载)' };
        }
        return { status: 'local_only', label: '未上传云端 (仅本地)' };
      }
      return { status: 'cloud_only', label: '云端书籍 (待下载)' };
    }

    if (hasLocal) {
      return { status: 'local_only', label: '未上传云端 (仅本地)' };
    }

    return null;
  }

  // 按需从 WebDAV 下载单本书籍的完整实体文件 (books/{id}.bin) 并写入本地数据库
  async downloadBookBinary(bookId) {
    if (!this.isWebDAVEnabled()) {
      throw new Error('WebDAV 未启用');
    }
    const id = String(bookId);
    this._currentlySyncingBookId = id;
    this._setState('syncing', null, { downloadingBookId: id });

    try {
      // 1. 从 WebDAV 获取实体文件
      const fileBlob = await this.client.getFile(`books/${id}.bin`, 'blob');
      if (!fileBlob) {
        throw new Error('云端未找到该书籍的实体文件');
      }

      // 2. 检查本地是否有书籍元数据
      let bookMeta = await this.library.getBookMetadata(id);
      if (!bookMeta) {
        const record = await this.client.getFile(`records/book_${id}.json`, 'json');
        bookMeta = record || { id, title: 'Downloaded Book', format: 'epub' };
      }

      // 3. 检查封面：若本地缺少封面，从云端拉取
      if (!bookMeta.cover) {
        try {
          const coverBlob = await this.client.getFile(`covers/${id}.bin`, 'blob');
          if (coverBlob) bookMeta.cover = coverBlob;
        } catch (_) {}
      }

      // 4. 将实体文件写入本地数据库
      if (typeof this.library.replaceBookContent === 'function') {
        await this.library.replaceBookContent(id, {
          ...bookMeta,
          file: fileBlob,
          size: fileBlob.size
        });
      } else if (typeof this.library.importBook === 'function') {
        await this.library.importBook({
          ...bookMeta,
          file: fileBlob,
          size: fileBlob.size
        });
      }

      // 5. 更新远端书籍缓存
      this._updateRemoteBookCache(id, {
        hasRecord: true,
        hasBinary: true,
        size: fileBlob.size
      });

      this._setState('success', null, { downloadedBookId: id });
      return true;
    } catch (err) {
      console.error(`[SyncManager] Download binary for book ${id} failed:`, err);
      this._setState('error', err.message || String(err));
      throw err;
    } finally {
      this._currentlySyncingBookId = null;
    }
  }

  // 单本书籍完整双向同步 / 上传 (可独立上传 70MB~100MB+ 大书)
  async syncSingleBook(bookId, options = {}) {
    if (!this.isWebDAVEnabled()) {
      throw new Error('未配置或未启用 WebDAV 远程存储模式');
    }

    const id = String(bookId);
    if (this._syncLock) {
      throw new Error('当前正在进行全局同步，请稍候');
    }

    this._currentlySyncingBookId = id;
    this._setState('syncing', null, { syncingBookId: id });

    try {
      await this._ensureRemoteDirectories();
      const book = await this.library.getBook(id);
      if (!book) throw new Error('本地未找到该书籍');

      // 1. 同步轻量阅读记录
      await this.syncSingleBookRecord(id, book);

      // 2. 上传封面（无论 Blob 还是 DataURL，均全量上传）
      if (book.cover) {
        const coverBlob = this._coverToBlob(book.cover);
        if (coverBlob) {
          try {
            await this.client.putFile(`covers/${id}.bin`, coverBlob);
          } catch (cErr) {
            console.log(`[SyncManager] Cover upload for book ${id} warning:`, cErr);
          }
        }
      }

      // 3. 上传原书文件（支持任意大体积文件：70MB~100MB+）
      let binaryUploaded = false;
      if (options.uploadBinary !== false && book.file) {
        await this.client.putFile(`books/${id}.bin`, book.file);
        binaryUploaded = true;
      }

      // 4. 更新远端 library.json 索引
      let remoteLibrary = null;
      try {
        remoteLibrary = await this.client.getFile('library.json', 'json');
      } catch (e) {}
      if (!remoteLibrary || !Array.isArray(remoteLibrary.books)) {
        remoteLibrary = { version: '1.0', updatedAt: 0, books: [] };
      }

      const existingIdx = remoteLibrary.books.findIndex(b => String(b.id) === id);
      const bookMeta = {
        id: book.id,
        title: book.title,
        author: book.author,
        format: book.format,
        size: book.size || (book.file ? book.file.size : 0),
        addedAt: book.addedAt,
        lastReadAt: book.lastReadAt,
        folder: book.folder || null
      };

      if (existingIdx >= 0) {
        remoteLibrary.books[existingIdx] = { ...remoteLibrary.books[existingIdx], ...bookMeta };
      } else {
        remoteLibrary.books.push(bookMeta);
      }
      remoteLibrary.updatedAt = Date.now();
      await this.client.putFile('library.json', remoteLibrary);

      // 5. 更新本地状态缓存
      this._updateRemoteBookCache(id, {
        hasRecord: true,
        hasBinary: binaryUploaded || Boolean(this.remoteBookCache.books?.[id]?.hasBinary),
        size: bookMeta.size
      });

      this._setState('success', null, { syncedBookId: id, hasLocalChanges: false });
      return { success: true };
    } catch (err) {
      console.error(`[SyncManager] Single book ${id} sync failed:`, err);
      this._setState('error', err.message || String(err), { failedBookId: id });
      throw err;
    } finally {
      this._currentlySyncingBookId = null;
    }
  }

  // 执行全量双向增量同步 (Sync All)
  // options.silent: 静默运行不弹窗
  // options.recordsOnly: 仅同步轻量阅读进度与配置，不传输原书大文件 (默认启动自动同步采用此模式)
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

    const recordsOnly = options.recordsOnly === true || this.config.syncMode === 'records_only';
    let hasLocalChanges = false;

    // 记录同步开始时间戳（用于死循环熔断防护）
    try {
      sessionStorage.setItem('edgereader_sync_attempt_time', String(Date.now()));
    } catch (e) {}

    this._syncLock = true;
    this._setState('syncing');

    try {
      // 1. 确保远端基础目录存在
      await this._ensureRemoteDirectories();

      // 2. 双向同步配置
      try {
        await this.syncSettings();
      } catch (cfgErr) {
        console.log('[SyncManager] Settings sync failed, continuing:', cfgErr);
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
          hasLocalChanges = true;
          if (this.remoteBookCache.books?.[deletedId]) {
            delete this.remoteBookCache.books[deletedId];
          }
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

      // 预先初始化远端书籍缓存
      for (const rb of remoteLibrary.books) {
        const rId = String(rb.id);
        const prev = this.remoteBookCache.books?.[rId] || {};
        this.remoteBookCache.books[rId] = {
          id: rId,
          hasRecord: true,
          hasBinary: prev.hasBinary || false,
          size: rb.size || 0,
          updatedAt: Date.now()
        };
      }

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

          // 【核心】：无论是否仅同步记录或原书是否已下载，全量同步拉取书籍封面
          let coverBlob = null;
          try {
            coverBlob = await this.client.getFile(`covers/${remoteId}.bin`, 'blob');
          } catch (cErr) {}
          if (coverBlob) {
            mergedMeta.cover = coverBlob;
          }

          // 若非 recordsOnly 且开启了完整同步模式，拉取书籍实体文件
          let fileBlob = null;
          if (!recordsOnly && this.config.syncMode === 'all') {
            try {
              fileBlob = await this.client.getFile(`books/${remoteId}.bin`, 'blob');
            } catch (fErr) {
              console.log(`[SyncManager] Failed to fetch book binary for ${remoteId}:`, fErr);
            }
            mergedMeta.file = fileBlob;
          }

          // 导入本地书库（即便实体文件未下载，书架也能完整展示封面和阅读记录）
          await this.library.importBook(mergedMeta);
          hasLocalChanges = true;

          this._updateRemoteBookCache(remoteId, {
            hasRecord: true,
            hasBinary: Boolean(fileBlob || this.remoteBookCache.books?.[remoteId]?.hasBinary),
            size: remoteMeta.size
          });
        }
      }

      // 8. 处理本地有、远端没有的书籍 (本地 -> 远端)
      for (const [localId, localBook] of localBookMap.entries()) {
        if (localDeletedIds.has(localId)) continue;
        if (!remoteBookMap.has(localId)) {
          // 上传轻量阅读记录
          await this.syncSingleBookRecord(localId, localBook);

          // 【核心】：全量双向同步封面，本地若有封面立即上传至云端（支持 Blob 与 DataURL）
          if (localBook.cover) {
            try {
              const coverBlob = this._coverToBlob(localBook.cover);
              if (coverBlob) {
                const coverExists = await this.client.exists(`covers/${localId}.bin`);
                if (!coverExists) {
                  await this.client.putFile(`covers/${localId}.bin`, coverBlob);
                }
              }
            } catch (covErr) {
              console.log(`[SyncManager] Failed to upload cover for book ${localId}:`, covErr);
            }
          }

          let hasBinary = false;
          // 若非 recordsOnly 且处于完整同步模式，上传书籍二进制（彻底解除 50MB 限制）
          if (!recordsOnly && this.config.syncMode === 'all') {
            try {
              const alreadyExists = await this.client.exists(`books/${localId}.bin`);
              if (!alreadyExists) {
                const fullBook = await this.library.getBook(localId);
                if (fullBook && fullBook.file) {
                  // 无体积封锁，支持 70MB~100MB+ 大书全量上传
                  await this.client.putFile(`books/${localId}.bin`, fullBook.file);
                  hasBinary = true;
                }
              } else {
                hasBinary = true;
              }
              // 给垃圾回收缓冲时间
              await new Promise(r => setTimeout(r, 60));
            } catch (upErr) {
              console.log(`[SyncManager] Failed to upload binary for book ${localId}:`, upErr);
            }
          }

          this._updateRemoteBookCache(localId, {
            hasRecord: true,
            hasBinary,
            size: localBook.size
          });
        }
      }

      // 9. 处理两端皆有的书籍 (双向差量 Smart Merge & 封面与缺失原书二进制自动补齐)
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

          const isRemoteNewer = remoteRecordUpdated > localLastRead;
          const isLocalNewer = localLastRead > remoteRecordUpdated;

          // 若远端更新或远端有新分类，拉取合并至本地；若本地更新或本地有新分类，推送到远端
          if (isRemoteNewer || (remoteRecord.folder && !localBook.folder && !isLocalNewer)) {
            await this.library.importBook({
              ...localBook,
              ...remoteRecord,
              id
            });
            hasLocalChanges = true;
          } else if (isLocalNewer || (localBook.folder && !remoteRecord.folder) || remoteRecord.folder !== localBook.folder) {
            await this.syncSingleBookRecord(id, localBook);
          }
        }

        // 【核心】：双向全量检查并补齐封面
        if (!localBook.cover) {
          // 本地缺失封面，尝试从远端拉取并更新本地书籍
          try {
            const remoteCoverBlob = await this.client.getFile(`covers/${id}.bin`, 'blob');
            if (remoteCoverBlob) {
              if (typeof this.library.updateBookCover === 'function') {
                await this.library.updateBookCover(id, remoteCoverBlob);
              }
              localBook.cover = remoteCoverBlob;
              hasLocalChanges = true;
            }
          } catch (_) {}
        } else {
          // 本地有封面，检查远端是否缺失并补传
          try {
            const coverBlob = this._coverToBlob(localBook.cover);
            if (coverBlob) {
              const remoteCoverExists = await this.client.exists(`covers/${id}.bin`);
              if (!remoteCoverExists) {
                await this.client.putFile(`covers/${id}.bin`, coverBlob);
              }
            }
          } catch (_) {}
        }

        // 检查远端是否缺失原书二进制（完整同步模式下）
        if (!recordsOnly && this.config.syncMode === 'all') {
          const cachedRemote = this.remoteBookCache?.books?.[id];
          if (!cachedRemote || !cachedRemote.hasBinary) {
            try {
              const binExists = await this.client.exists(`books/${id}.bin`);
              if (!binExists) {
                const fullBook = await this.library.getBook(id);
                if (fullBook && fullBook.file) {
                  await this.client.putFile(`books/${id}.bin`, fullBook.file);
                }
              }
              this._updateRemoteBookCache(id, { hasBinary: true });
              await new Promise(r => setTimeout(r, 60));
            } catch (binErr) {
              console.log(`[SyncManager] Failed to backfill binary for book ${id}:`, binErr);
            }
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

      // 11. 记录同步成功状态与持久化缓存
      this.lastSyncTime = Date.now();
      try {
        localStorage.setItem('edgereader_last_sync_time', String(this.lastSyncTime));
      } catch (e) {}
      this._saveRemoteBookCache();

      this._setState('success', null, { hasLocalChanges });
      return { success: true, count: cleanIndexList.length, hasLocalChanges };
    } catch (err) {
      console.error('[SyncManager] Sync failed:', err);
      this._setState('error', err.message || String(err));
      if (!options.silent) throw err;
    } finally {
      this._syncLock = false;
      try {
        sessionStorage.removeItem('edgereader_sync_attempt_time');
      } catch (e) {}
    }
  }
}
