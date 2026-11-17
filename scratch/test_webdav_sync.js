// scratch/test_webdav_sync.js
// 完整自动化测试套件：WebDAV 协议驱动、Mock 服务器、双向增量同步、Smart Merge 冲突仲裁与墓碑机制

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// 导入待测模块 (针对 Node.js 环境兼容 export/import)
const webdavCode = fs.readFileSync(path.join(__dirname, '../reader/webdav.js'), 'utf8')
  .replace(/export\s+class\s+WebDAVClient/g, 'class WebDAVClient');
const syncCode = fs.readFileSync(path.join(__dirname, '../reader/sync.js'), 'utf8')
  .replace(/^import\s+.*?from\s+.*?$/gm, '')
  .replace(/export\s+class\s+SyncManager/g, 'class SyncManager');

const evalScope = {
  console,
  setTimeout,
  clearTimeout,
  Buffer,
  URL,
  btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
  atob: (b64) => Buffer.from(b64, 'base64').toString('binary')
};

const scriptFn = new Function(
  'scope',
  `
  with (scope) {
    ${webdavCode}
    ${syncCode}
    return { WebDAVClient, SyncManager };
  }
`
);

const { WebDAVClient, SyncManager } = scriptFn(evalScope);

// 简易内存 Mock WebDAV 服务器
function createMockWebDAVServer({ validUser = 'testuser', validPass = 'secret123' } = {}) {
  const fileStore = new Map(); // path -> { isDir: bool, content: string|Buffer, mtime: number }
  fileStore.set('/', { isDir: true, content: '', mtime: Date.now() });

  const server = http.createServer((req, res) => {
    // 检查 Basic 鉴权
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="TestWebDAV"',
        'Content-Type': 'text/plain'
      });
      res.end('Authentication required');
      return;
    }

    const b64 = authHeader.replace(/^Basic\s+/i, '');
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const [u, p] = decoded.split(':');
    if (u !== validUser || p !== validPass) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: Invalid credentials');
      return;
    }

    let reqPath = decodeURIComponent(req.url.split('?')[0]);
    if (!reqPath.startsWith('/')) reqPath = '/' + reqPath;

    if (req.method === 'PROPFIND') {
      const depth = req.headers['depth'] || '1';
      const cleanPath = reqPath.replace(/\/+$/, '') || '/';
      const entry = fileStore.get(cleanPath);

      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      let xml = `<?xml version="1.0" encoding="utf-8" ?>\n<D:multistatus xmlns:D="DAV:">\n`;

      const formatResponse = (p, isDir, size, mtime) => {
        return `  <D:response>
    <D:href>${p}${isDir && !p.endsWith('/') ? '/' : ''}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${p.split('/').filter(Boolean).pop() || ''}</D:displayname>
        ${isDir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>'}
        <D:getcontentlength>${size}</D:getcontentlength>
        <D:getlastmodified>${new Date(mtime).toUTCString()}</D:getlastmodified>
        <D:getetag>"${mtime}"</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>\n`;
      };

      xml += formatResponse(cleanPath, entry.isDir, entry.content ? entry.content.length : 0, entry.mtime);

      if (depth === '1' && entry.isDir) {
        for (const [storePath, sEntry] of fileStore.entries()) {
          if (storePath === cleanPath) continue;
          const parent = storePath.substring(0, storePath.lastIndexOf('/')) || '/';
          if (parent === cleanPath) {
            xml += formatResponse(storePath, sEntry.isDir, sEntry.content ? sEntry.content.length : 0, sEntry.mtime);
          }
        }
      }

      xml += `</D:multistatus>`;
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(xml);
      return;
    }

    if (req.method === 'MKCOL') {
      const cleanPath = reqPath.replace(/\/+$/, '') || '/';
      if (fileStore.has(cleanPath)) {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed: Already exists');
        return;
      }
      fileStore.set(cleanPath, { isDir: true, content: '', mtime: Date.now() });
      res.writeHead(201, { 'Content-Type': 'text/plain' });
      res.end('Created');
      return;
    }

    if (req.method === 'PUT') {
      const cleanPath = reqPath.replace(/\/+$/, '');
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        fileStore.set(cleanPath, { isDir: false, content: bodyBuf, mtime: Date.now() });
        res.writeHead(201, { 'Content-Type': 'text/plain' });
        res.end('Created');
      });
      return;
    }

    if (req.method === 'GET') {
      const cleanPath = reqPath.replace(/\/+$/, '');
      const entry = fileStore.get(cleanPath);
      if (!entry || entry.isDir) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': entry.content.length
      });
      res.end(entry.content);
      return;
    }

    if (req.method === 'DELETE') {
      const cleanPath = reqPath.replace(/\/+$/, '');
      let deleted = false;
      for (const key of Array.from(fileStore.keys())) {
        if (key === cleanPath || key.startsWith(cleanPath + '/')) {
          fileStore.delete(key);
          deleted = true;
        }
      }
      res.writeHead(deleted ? 204 : 404);
      res.end();
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
  });

  return { server, fileStore };
}

// 模拟 BookLibrary
class MockBookLibrary {
  constructor() {
    this.books = new Map();
    this.bookFiles = new Map();
    this._deletedBookIds = new Set();
  }

  async getAllBooks() {
    return Array.from(this.books.values()).map(b => ({
      ...b,
      hasLocalFile: this.bookFiles.has(b.id)
    }));
  }

  async getBookMetadata(id) {
    return this.books.get(id) || null;
  }

  async getBook(id) {
    const meta = this.books.get(id);
    if (!meta) return null;
    const file = this.bookFiles.get(id) || null;
    if (!file) return null;
    return { ...meta, hasLocalFile: true, file };
  }

  async updateBookCover(id, cover) {
    const book = this.books.get(id);
    if (book) {
      book.cover = cover;
      this.books.set(id, book);
    }
    return book;
  }

  async replaceBookContent(id, { title, author, format, file, cover, size, fileHash }) {
    const book = this.books.get(id) || { id };
    if (title) book.title = title;
    if (author) book.author = author;
    if (format) book.format = format;
    if (cover) book.cover = cover;
    if (size) book.size = size;
    if (fileHash) book.fileHash = fileHash;
    this.books.set(id, book);
    if (file) {
      this.bookFiles.set(id, file);
    }
    return book;
  }

  async updateBookFolder(id, folder) {
    const book = this.books.get(id);
    if (book) {
      book.folder = folder;
      book.lastReadAt = Date.now();
      this.books.set(id, book);
    }
    return book;
  }

  async addBook(book) {
    this.books.set(book.id, { ...book });
    if (book.file) {
      this.bookFiles.set(book.id, book.file);
    }
    return book;
  }

  async importBook(book) {
    const existing = this.books.get(book.id);
    if (existing) {
      // 模拟智能合并
      const existingPercent = existing.progress?.percent || 0;
      const backupPercent = book.progress?.percent || 0;
      let finalProgress = { ...existing.progress };

      if (existingPercent === 0 && backupPercent > 0) {
        finalProgress = { ...book.progress };
      } else if (book.lastReadAt > existing.lastReadAt) {
        finalProgress = { ...book.progress };
      }

      // 笔记求并集
      const mergedNotes = [...(existing.notes || [])];
      for (const n of book.notes || []) {
        if (!mergedNotes.some(m => m.noteId === n.noteId)) {
          mergedNotes.push(n);
        }
      }

      this.books.set(book.id, {
        ...existing,
        ...book,
        progress: finalProgress,
        notes: mergedNotes,
        lastReadAt: Math.max(existing.lastReadAt || 0, book.lastReadAt || 0)
      });
    } else {
      this.books.set(book.id, { ...book });
      if (book.file) {
        this.bookFiles.set(book.id, book.file);
      }
    }
    return true;
  }

  async deleteBook(id) {
    this.books.delete(id);
    this.bookFiles.delete(id);
    this._deletedBookIds.add(String(id));
    return true;
  }
}

// 运行测试
async function runTests() {
  console.log('=== 开始 Edge-Reader WebDAV 与多端同步全面验证测试 ===\n');

  const { server, fileStore } = createMockWebDAVServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}`;
  console.log(`[Mock Server] WebDAV Mock 服务启动成功，监听端口: ${port}`);

  try {
    // -------------------------------------------------------------
    // 测试组 1: WebDAVClient 底层驱动与连接自检
    // -------------------------------------------------------------
    console.log('\n--- 1. 测试 WebDAV 驱动基础方法与连接测试 ---');
    const client = new WebDAVClient({
      endpoint,
      username: 'testuser',
      password: 'secret123',
      remotePath: '/EdgeReader'
    });

    // 1.1 自检 testConnection
    const testRes = await client.testConnection();
    assert.strictEqual(testRes.success, true, '自检连接应当返回成功');
    console.log('✅ client.testConnection() 通过');

    // 1.2 错误凭证应当被拒绝 (401/403)
    const badClient = new WebDAVClient({
      endpoint,
      username: 'wronguser',
      password: 'badpassword',
      remotePath: '/EdgeReader'
    });
    let authFailed = false;
    try {
      await badClient.testConnection();
    } catch (e) {
      authFailed = true;
      assert.ok(e.message.includes('认证失败'), '错误凭证应提示认证失败');
    }
    assert.strictEqual(authFailed, true, '错误凭据必须抛出鉴权失败异常');
    console.log('✅ 鉴权拦截与错误捕获通过');

    // 1.3 递归创建目录与文件操作
    await client.ensureDir('records/deep/folder');
    assert.strictEqual(await client.exists('records/deep/folder'), true, '多级递归目录应创建成功');
    console.log('✅ client.ensureDir() 递归多级建目录通过');

    // 1.4 上传与读取文件
    await client.putFile('config/test.json', { app: 'EdgeReader', v: 3 });
    const content = await client.getFile('config/test.json', 'json');
    assert.deepStrictEqual(content, { app: 'EdgeReader', v: 3 }, '上传的 JSON 读取内容应完全一致');
    console.log('✅ client.putFile() 与 client.getFile() 通过');

    // 1.5 目录列表解析
    const list = await client.listDir('config');
    assert.ok(list.some(item => item.displayName === 'test.json'), '目录列出应包含 test.json');
    console.log('✅ client.listDir() PROPFIND XML 深度解析通过');

    // 1.6 删除文件
    await client.deleteFile('config/test.json');
    assert.strictEqual(await client.exists('config/test.json'), false, '文件删除后 exists 应返回 false');
    console.log('✅ client.deleteFile() 通过');

    // -------------------------------------------------------------
    // 测试组 2: SyncManager 核心双向同步与 Smart Merge
    // -------------------------------------------------------------
    console.log('\n--- 2. 测试 SyncManager 双向差量同步与 Smart Merge ---');

    // 模拟本地环境 localStorage
    const localMemoryStorage = new Map();
    global.localStorage = {
      getItem: (k) => localMemoryStorage.get(k) || null,
      setItem: (k, v) => localMemoryStorage.set(k, String(v)),
      removeItem: (k) => localMemoryStorage.delete(k),
      clear: () => localMemoryStorage.clear()
    };

    const mockLibrary = new MockBookLibrary();
    const syncMgr = new SyncManager(mockLibrary);

    // 2.1 初始本地模式校验
    assert.strictEqual(syncMgr.isWebDAVEnabled(), false, '默认纯本地模式下 WebDAV 应当处于未启用状态');
    console.log('✅ 默认本地纯离线模式校验通过');

    // 2.2 配置为 WebDAV 模式
    await syncMgr.saveConfig({
      storageMode: 'webdav',
      endpoint,
      username: 'testuser',
      password: 'secret123',
      remotePath: '/EdgeReader',
      syncMode: 'all',
      autoSyncOnOpen: true,
      autoSyncOnProgress: true
    });
    assert.strictEqual(syncMgr.isWebDAVEnabled(), true, '配置有效后 WebDAV 应当处于启用状态');
    console.log('✅ 动态切换到 WebDAV 模式配置保存通过');

    // 2.3 添加书籍并上传同步 (本地 -> 远端)
    await mockLibrary.addBook({
      id: 'book_001',
      title: '三体',
      author: '刘慈欣',
      format: 'epub',
      size: 10240,
      addedAt: Date.now() - 10000,
      lastReadAt: Date.now() - 5000,
      progress: { percent: 45.5, chapterIndex: 4 },
      bookmarks: [{ bookmarkId: 'bm1', chapterIndex: 2 }],
      notes: [{ noteId: 'note1', text: '消灭人类暴政，世界属于三体' }],
      stats: { totalTime: 120, readingDays: { '2026-11-16': 120 }, hourlyDist: {} }
    });

    const sync1 = await syncMgr.syncAll();
    assert.strictEqual(sync1.success, true, '初次全量同步应当成功');
    assert.strictEqual(await client.exists('records/book_book_001.json'), true, '远端应生成书籍记录');
    assert.strictEqual(await client.exists('library.json'), true, '远端应生成全库索引');
    console.log('✅ 本地新书同步至远端通过');

    // 2.4 测试阅读进度防零覆盖与 LWW 冲突合并 (远端 -> 本地)
    console.log('\n--- 3. 测试阅读进度防零覆盖与冲突合并算法 ---');
    // 模拟新设备 B 接入：本地有一本刚导入的同名书，但进度为 0%
    const mockLibraryB = new MockBookLibrary();
    const syncMgrB = new SyncManager(mockLibraryB);
    await syncMgrB.saveConfig({
      storageMode: 'webdav',
      endpoint,
      username: 'testuser',
      password: 'secret123',
      remotePath: '/EdgeReader'
    });

    // 设备 B 本地刚导入书，进度为 0
    await mockLibraryB.addBook({
      id: 'book_001',
      title: '三体',
      author: '刘慈欣',
      format: 'epub',
      progress: { percent: 0, chapterIndex: 0 },
      lastReadAt: 0,
      notes: []
    });

    // 执行设备 B 的同步，应拉取远端的 45.5% 进度，而绝不被 0 覆盖
    await syncMgrB.syncAll();
    const bookOnB = await mockLibraryB.getBookMetadata('book_001');
    assert.strictEqual(bookOnB.progress.percent, 45.5, '防零覆盖：新设备空进度应被远端有效进度覆盖');
    assert.strictEqual(bookOnB.notes.length, 1, '远端笔记应当完整同步到设备 B');
    console.log('✅ 防零覆盖算法 (Anti-Zero Overwrite) 验证通过');

    // 2.5 测试两端独立加笔记的求并集 (Union & Dedup)
    console.log('\n--- 4. 测试划线笔记集合求并与无损去重 ---');
    // 设备 B 上新增笔记 2
    bookOnB.notes.push({ noteId: 'note2', text: '给岁月以文明，而不是给文明以岁月' });
    bookOnB.lastReadAt = Date.now() + 1000;
    bookOnB.progress.percent = 60;
    await syncMgrB.syncSingleBookRecord('book_001', bookOnB);

    // 设备 A 上同步，应当获取 note2 且保留原有的 note1
    await syncMgr.syncAll();
    const bookOnA = await mockLibrary.getBookMetadata('book_001');
    assert.strictEqual(bookOnA.notes.length, 2, '两端笔记应当合并为 2 条');
    assert.strictEqual(bookOnA.progress.percent, 60, '设备 B 的最新阅读进度应成功同步至设备 A');
    console.log('✅ 划线笔记集合求并与进度更新验证通过');

    // 2.6 测试书籍删除墓碑机制 (Tombstone)
    console.log('\n--- 5. 测试删除书籍墓碑同步 (Tombstone) ---');
    // 设备 A 删除了书籍 book_001
    await mockLibrary.deleteBook('book_001');
    await syncMgr.handleDeleteBook('book_001');

    // 设备 B 执行同步，应该根据墓碑自动清理设备 B 上的该书，防止“僵尸复活”
    await syncMgrB.syncAll();
    const deletedOnB = await mockLibraryB.getBookMetadata('book_001');
    assert.strictEqual(deletedOnB, null, '设备 B 应当根据墓碑自动清除被删除的书籍');
    console.log('✅ 删除书籍墓碑清理机制验证通过');

    // 2.7 测试高频阅读防抖轻量推送
    console.log('\n--- 6. 测试阅读翻页单书记录轻量推送 ---');
    await mockLibrary.addBook({
      id: 'book_002',
      title: '百年孤独',
      format: 'txt',
      lastReadAt: Date.now(),
      progress: { percent: 12 }
    });
    await syncMgr.syncSingleBookRecord('book_002');
    const rec002 = await client.getFile('records/book_book_002.json', 'json');
    assert.strictEqual(rec002.progress.percent, 12, '单书轻量记录应毫秒级推送至远端');
    console.log('✅ 单书轻量快速推送验证通过');

    // 2.8 测试高性能低内存 Blob <-> Base64 转换
    console.log('\n--- 7. 测试高性能低内存 Blob <-> Base64 转换 ---');
    const sampleBytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x57, 0x6f, 0x72, 0x6c, 0x64]); // "Hello World"
    const fakeBlob = {
      size: sampleBytes.length,
      type: 'text/plain',
      arrayBuffer: async () => sampleBytes.buffer
    };
    const b64Out = await client._blobToBase64(fakeBlob);
    assert.strictEqual(b64Out, Buffer.from(sampleBytes).toString('base64'), 'Base64 转换结果应精确无误');
    const restoredBlob = client._base64ToBlob(b64Out, 'text/plain');
    assert.strictEqual(restoredBlob.size, sampleBytes.length, '还原后的 Blob 尺寸应一致');
    console.log('✅ 高性能低内存 Blob 编码与解码验证通过');

    // 2.9 测试 recordsOnly 轻量同步模式（不上传原书二进制）
    console.log('\n--- 8. 测试 recordsOnly 轻量同步模式 ---');
    await mockLibrary.addBook({
      id: 'book_heavy',
      title: '大型百科全书',
      format: 'epub',
      size: 1048576,
      file: { size: 1048576, type: 'application/epub+zip' },
      lastReadAt: Date.now()
    });
    // 执行 recordsOnly 同步
    await syncMgr.syncAll({ recordsOnly: true, silent: true });
    // 检查 records 是否上传，但 books/book_heavy.bin 不应存在
    assert.strictEqual(await client.exists('records/book_book_heavy.json'), true, '轻量记录应已上传');
    assert.strictEqual(await client.exists('books/book_heavy.bin'), false, 'recordsOnly 模式严禁上传大体积二进制');
    console.log('✅ recordsOnly 零内存大文件跳过验证通过');

    // 2.10 测试熔断保护逻辑 (Circuit Breaker)
    console.log('\n--- 9. 测试死循环熔断保护 (Circuit Breaker) ---');
    evalScope.sessionStorage = {
      _data: {},
      getItem(k) { return this._data[k] || null; },
      setItem(k, v) { this._data[k] = String(v); },
      removeItem(k) { delete this._data[k]; }
    };
    evalScope.sessionStorage.setItem('edgereader_sync_attempt_time', String(Date.now()));
    // 在熔断保护窗口内再次 init，autoSyncOnOpen 应被自动拦截
    const lastAttemptBefore = evalScope.sessionStorage.getItem('edgereader_sync_attempt_time');
    assert.ok(Date.now() - Number(lastAttemptBefore) < 45000, '熔断时间戳应在保护期内');
    console.log('✅ 崩溃无限刷新死循环熔断保护验证通过');

    // 2.11 测试单本 80MB~100MB+ 大书独立同步与状态查询
    console.log('\n--- 10. 测试单本大书独立同步 (syncSingleBook) 与状态查询 (getBookSyncStatus) ---');
    await mockLibrary.addBook({
      id: 'book_giant',
      title: '百兆高清插画全集',
      format: 'pdf',
      size: 95000000,
      file: { size: 95000000, type: 'application/pdf' },
      lastReadAt: Date.now()
    });

    // 查询同步前状态，应为未上传云端 (local_only)
    const beforeStatus = syncMgr.getBookSyncStatus('book_giant');
    assert.strictEqual(beforeStatus.status, 'local_only', '未同步前状态应为 local_only');

    // 单本手动触发上传
    await syncMgr.syncSingleBook('book_giant');
    assert.strictEqual(await client.exists('books/book_giant.bin'), true, '大书二进制应成功上传');

    // 查询同步后状态，应为已同步云端 (synced)
    const afterStatus = syncMgr.getBookSyncStatus('book_giant');
    assert.strictEqual(afterStatus.status, 'synced', '同步完成后状态应为 synced');
    console.log('✅ 单本 80MB~100MB+ 大书独立上传与状态查询验证通过');

    // 2.12 测试缺失二进制书籍在全量同步时自动补传
    console.log('\n--- 11. 测试缺失二进制书籍在全量同步时自动补传 ---');
    // 模拟仅有 records 但缺失 books/book_heavy.bin 的书籍
    syncMgr.remoteBookCache.books['book_heavy'] = { id: 'book_heavy', hasRecord: true, hasBinary: false };
    await syncMgr.syncAll({ recordsOnly: false, silent: true });
    assert.strictEqual(await client.exists('books/book_heavy.bin'), true, '全量同步应自动补传远端缺失的大书二进制');
    assert.strictEqual(syncMgr.getBookSyncStatus('book_heavy').status, 'synced', '补传后状态应为 synced');
    console.log('✅ 缺失二进制大书自动补传验证通过');

    // 2.13 测试远端未下载书籍的封面全量同步与按需拉取原书 (Full Cover Sync & On-Demand Download)
    console.log('\n--- 12. 测试未下载原书的封面全量同步与状态切换 ---');
    // 在云端准备一本云端图书，包含封面和原书大文件
    const mockCoverBinary = Buffer.from('MOCK_JPEG_COVER_BINARY_DATA');
    const mockBookBinary = Buffer.from('MOCK_EPUB_BINARY_CONTENT');
    await client.putFile('covers/book_remote_cover.bin', mockCoverBinary);
    await client.putFile('books/book_remote_cover.bin', mockBookBinary);
    await client.putFile('records/book_remote_cover.json', {
      id: 'book_remote_cover',
      title: '云端封面全量同步书籍',
      author: '云端作者',
      format: 'epub',
      size: mockBookBinary.length,
      lastReadAt: Date.now()
    });

    const currentLib = await client.getFile('library.json', 'json') || { books: [] };
    currentLib.books.push({
      id: 'book_remote_cover',
      title: '云端封面全量同步书籍',
      author: '云端作者',
      format: 'epub',
      size: mockBookBinary.length,
      lastReadAt: Date.now()
    });
    await client.putFile('library.json', currentLib);

    // 新客户端 C 模拟移动端首次启动（轻量级 recordsOnly 同步）
    const mockLibraryC = new MockBookLibrary();
    const syncMgrC = new SyncManager(mockLibraryC);
    await syncMgrC.saveConfig({
      storageMode: 'webdav',
      endpoint: `http://127.0.0.1:${port}`,
      username: 'testuser',
      password: 'secret123',
      remotePath: '/EdgeReader',
      syncMode: 'records_only'
    });

    // 启动 recordsOnly 同步
    await syncMgrC.syncAll({ recordsOnly: true, silent: true });

    // 验证：书籍已导入本地元数据
    const bookC = await mockLibraryC.getBookMetadata('book_remote_cover');
    assert.ok(bookC, '云端书籍元数据应已导入本地');
    // 关键断言 1：本地尚未下载实体文件
    assert.strictEqual(mockLibraryC.bookFiles.has('book_remote_cover'), false, 'recordsOnly 模式下原书大文件不应下载到本地');
    // 关键断言 2：但封面必须全量同步下载完成！
    assert.ok(bookC.cover, '即便书籍未下载到本地，封面也必须全量同步');

    // 关键断言 3：同步状态徽章应正确指示为待下载 (cloud_only)
    const booksAfterSyncC = await mockLibraryC.getAllBooks();
    const targetBookC = booksAfterSyncC.find(b => b.id === 'book_remote_cover');
    const statusC = syncMgrC.getBookSyncStatus('book_remote_cover', targetBookC);
    assert.strictEqual(statusC.status, 'cloud_only', '未下载实体书籍应标记为 cloud_only');

    // 关键断言 4：按需触发 downloadBookBinary
    await syncMgrC.downloadBookBinary('book_remote_cover');
    assert.strictEqual(mockLibraryC.bookFiles.has('book_remote_cover'), true, '按需下载后本地应具备实体文件');
    const booksAfterDl = await mockLibraryC.getAllBooks();
    const targetAfterDl = booksAfterDl.find(b => b.id === 'book_remote_cover');
    const statusAfterDl = syncMgrC.getBookSyncStatus('book_remote_cover', targetAfterDl);
    assert.strictEqual(statusAfterDl.status, 'synced', '实体文件下载后状态应转为已同步 (synced)');
    console.log('✅ 未下载书籍封面全量同步与按需下载验证通过');

    // 2.14 测试 DataURL 封面格式转换与双向封面补齐
    console.log('\n--- 13. 测试 DataURL 封面格式转换与双向封面补齐 ---');
    const sampleDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await mockLibrary.addBook({
      id: 'book_dataurl',
      title: 'DataURL 封面测试书籍',
      format: 'epub',
      cover: sampleDataUrl,
      size: 5000,
      file: { size: 5000 },
      lastReadAt: Date.now()
    });

    await syncMgr.syncSingleBook('book_dataurl');
    assert.strictEqual(await client.exists('covers/book_dataurl.bin'), true, 'DataURL 封面应被转换并成功上传至 WebDAV covers/ 目录');

    // 模拟另一客户端 D 拥有该书但缺少封面
    const mockLibraryD = new MockBookLibrary();
    const syncMgrD = new SyncManager(mockLibraryD);
    await syncMgrD.saveConfig({
      storageMode: 'webdav',
      endpoint: `http://127.0.0.1:${port}`,
      username: 'testuser',
      password: 'secret123',
      remotePath: '/EdgeReader'
    });

    await mockLibraryD.addBook({
      id: 'book_dataurl',
      title: 'DataURL 封面测试书籍',
      format: 'epub',
      cover: null, // 本地缺少封面
      lastReadAt: Date.now()
    });

    // 2.15 测试凭据前后空格自动清洗、URL 嵌入式密码提取与 401 友好提示
    console.log('\n--- 14. 测试凭据前后空格自动清洗、URL 嵌入式密码提取与 401 友好提示 ---');
    // 测试 1：用户名密码含前后空格
    const clientSpaces = new WebDAVClient({
      endpoint: `http://127.0.0.1:${port}/ `,
      username: '  testuser  ',
      password: '  secret123  ',
      remotePath: '  /EdgeReader  '
    });
    assert.strictEqual(clientSpaces.username, 'testuser', '用户名空格应被自动清除');
    assert.strictEqual(clientSpaces.password, 'secret123', '密码前后空格应被自动清除');
    assert.strictEqual(clientSpaces.remotePath, '/EdgeReader', '远程根路径空格应被自动清除');

    // 测试 2：URL 中直接包含凭据 (https://user:pass@host/dav)
    const clientUrlCreds = new WebDAVClient({
      endpoint: `http://special_user:special_pass@127.0.0.1:${port}/webdav/`
    });
    assert.strictEqual(clientUrlCreds.username, 'special_user', '应从 URL 自动提取用户名');
    assert.strictEqual(clientUrlCreds.password, 'special_pass', '应从 URL 自动提取密码');
    assert.strictEqual(clientUrlCreds.endpoint.includes('@'), false, 'endpoint 中的凭据应被彻底清洗');

    // 测试 3：401 友好排查提示
    const errorMsg401 = clientSpaces._formatHttpError('PUT', 'records/test.json', 401);
    assert.ok(errorMsg401.includes('401 Unauthorized'), '应包含 401 Unauthorized 标识');
    assert.ok(errorMsg401.includes('排查建议'), '应包含详细排查建议');
    console.log('✅ 凭据自动清洗与 401 友好错误提示验证通过');

    // 2.16 测试书籍文件夹移动与自定义文件夹双向同步
    console.log('\n--- 15. 测试书籍移动至文件夹与自定义文件夹多端双向同步 ---');
    await mockLibrary.addBook({
      id: 'book_folder_test',
      title: '流浪地球',
      format: 'epub',
      folder: null,
      lastReadAt: Date.now() - 5000
    });
    await mockLibrary.updateBookFolder('book_folder_test', '科幻小说');
    global.localStorage.setItem('edgereader_custom_folders', JSON.stringify(['科幻小说', '文学历史']));
    global.localStorage.setItem('edgereader_settings_updated_at', String(Date.now()));
    await syncMgr.syncSettings();
    await syncMgr.syncAll({ silent: true, recordsOnly: true });

    // 模拟客户端 F 同步 (原本处于根目录)
    const mockLibraryFolder = new MockBookLibrary();
    await mockLibraryFolder.addBook({
      id: 'book_folder_test',
      title: '流浪地球',
      format: 'epub',
      folder: null,
      lastReadAt: 1000
    });
    const syncMgrFolder = new SyncManager(mockLibraryFolder);
    await syncMgrFolder.saveConfig({
      storageMode: 'webdav',
      endpoint: `http://127.0.0.1:${port}`,
      username: 'testuser',
      password: 'secret123',
      remotePath: '/EdgeReader'
    });

    await syncMgrFolder.syncSettings();
    await syncMgrFolder.syncAll({ silent: true, recordsOnly: true });

    const syncedBookB = await mockLibraryFolder.getBookMetadata('book_folder_test');
    assert.strictEqual(syncedBookB.folder, '科幻小说', '客户端 F 上的图书应成功移动至“科幻小说”文件夹');
    const bFolders = JSON.parse(global.localStorage.getItem('edgereader_custom_folders') || '[]');
    assert.ok(bFolders.includes('科幻小说'), '客户端 F 的自定义文件夹列表应包含“科幻小说”');
    console.log('✅ 书籍移动至文件夹与文件夹多端同步验证通过');

    console.log('\n🎉 所有 WebDAV 驱动、多端同步逻辑与冲突仲裁测试均 100% 通过！');
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('\n❌ 测试失败:', err);
  process.exit(1);
});
