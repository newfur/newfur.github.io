// reader/webdav.js
// 跨平台 WebDAV 客户端驱动
// 支持浏览器原生 fetch、Chrome MV3 扩展环境以及 Capacitor 原生穿透 (iOS / Android)

export class WebDAVClient {
  constructor(options = {}) {
    let rawEndpoint = (options.endpoint || '').trim().replace(/\/+$/, '');
    let username = (options.username || '').trim();
    let password = (options.password || '').trim();

    // 智能提取：若用户在 endpoint 中直接输入了凭据 (如 https://user:pass@example.com/dav)
    if (rawEndpoint.includes('@')) {
      try {
        const u = new URL(rawEndpoint);
        if (u.username && !username) username = decodeURIComponent(u.username);
        if (u.password && !password) password = decodeURIComponent(u.password);
        u.username = '';
        u.password = '';
        rawEndpoint = u.toString().replace(/\/+$/, '');
      } catch (_) {}
    }

    this.endpoint = rawEndpoint;
    this.username = username;
    this.password = password;
    this.remotePath = this._normalizeRemotePath(options.remotePath || '/EdgeReader');
    this.timeout = options.timeout || 30000;

    // 智能去重：若 endpoint 末尾已经包含了 remotePath，防止形成 /EdgeReader/EdgeReader 双重路径
    if (this.remotePath && this.remotePath !== '/' && this.endpoint.endsWith(this.remotePath)) {
      this.endpoint = this.endpoint.slice(0, -this.remotePath.length).replace(/\/+$/, '');
    }
  }

  // 人性化格式化 HTTP 错误提示，精准定位 401 认证与权限问题
  _formatHttpError(action, relativePath, status, statusText = '') {
    if (status === 401) {
      return `WebDAV 认证失败 (HTTP 401 Unauthorized): 无法执行 ${action} ${relativePath}。\n` +
        `【排查建议】\n` +
        `1. 请检查 WebDAV 用户名与密码是否正确（注意区分大小写，避免前后多出空格）；\n` +
        `2. 若您的云盘服务（如 Nextcloud、坚果云、群晖等）开启了双因素认证(2FA)，必须使用专属「应用令牌 / App Password」代替网页登录密码；\n` +
        `3. 若使用的是公共只读分享或访客账户，由于只读权限允许下载却禁止上传，写入时会触发 401，请更换为具有完整读写权限的账号；\n` +
        `4. 若服务器配置了 HTTP 强制跳转 HTTPS，请直接将服务地址协议修改为 https://。`;
    }
    if (status === 403) {
      return `WebDAV 访问被拒绝 (HTTP 403 Forbidden): 无法执行 ${action} ${relativePath}。当前账号可能缺少写入权限，或路径受服务器安全策略保护。`;
    }
    if (status === 404) {
      return `WebDAV 路径不存在 (HTTP 404 Not Found): ${relativePath}`;
    }
    return `WebDAV ${action} ${relativePath} failed with status ${status}: ${statusText || ''}`;
  }

  // 规范化远端根路径，确保以 / 开头，无末尾 /
  _normalizeRemotePath(p) {
    if (!p) return '/EdgeReader';
    let clean = p.trim().replace(/\\/g, '/');
    if (!clean.startsWith('/')) clean = '/' + clean;
    return clean.replace(/\/+$/, '');
  }

  // 构造 HTTP Authorization 请求头
  _getAuthHeader() {
    if (!this.username && !this.password) return null;
    const cred = `${this.username}:${this.password}`;
    try {
      const b64 = (typeof btoa === 'function')
        ? btoa(unescape(encodeURIComponent(cred)))
        : Buffer.from(cred).toString('base64');
      return `Basic ${b64}`;
    } catch (e) {
      console.warn('[WebDAV] Failed to encode credentials:', e);
      return null;
    }
  }

  // 拼接并对 URL 路径进行安全编码（保留 / 分隔符）
  buildUrl(relativePath = '') {
    let combined = this.remotePath;
    if (relativePath) {
      const rel = relativePath.startsWith('/') ? relativePath : '/' + relativePath;
      combined += rel;
    }
    // 拆分各级路径并做 URL encode
    const segments = combined.split('/').map(seg => encodeURIComponent(seg));
    const encodedPath = segments.join('/');
    return `${this.endpoint}${encodedPath}`;
  }

  // 判断是否处于 Capacitor 原生环境 (可使用 CapacitorHttp 规避浏览器 CORS 限制)
  _isCapacitorNative() {
    if (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins) {
      if (window.Capacitor.Plugins.CapacitorHttp) {
        return true;
      }
    }
    return false;
  }

  // 统一底层 HTTP 发送请求
  async request({ url, method = 'GET', headers = {}, body = null, responseType = 'text', timeout = null }) {
    const finalHeaders = { ...headers };
    const auth = this._getAuthHeader();
    if (auth && !finalHeaders['Authorization']) {
      finalHeaders['Authorization'] = auth;
    }

    const effectiveTimeout = timeout || this.timeout;

    // 在 Capacitor 原生环境下，如果上传的是大体积 Blob（> 5MB），优先尝试 WebKit 原生流式 fetch
    // 因为原生 fetch 支持底层零内存流式传输，避免将 100MB 二进制转为 Base64 造成 WebKit IPC 压力
    if (this._isCapacitorNative() && body instanceof Blob && body.size > 5 * 1024 * 1024 && typeof window.CapacitorWebFetch === 'function') {
      try {
        const streamRes = await this._requestFetch({
          url,
          method,
          headers: finalHeaders,
          body,
          responseType,
          timeout: effectiveTimeout,
          fetchFn: window.CapacitorWebFetch
        });
        if (streamRes && streamRes.ok) {
          return streamRes;
        }
      } catch (streamErr) {
        // 若遇到 CORS 等限制，安全自动降级到 Capacitor 原生网络插件
        console.warn('[WebDAV] Native streaming fetch failed or restricted, falling back to CapacitorHttp:', streamErr.message);
      }
    }

    // 优先使用 Capacitor 原生 HTTP（iOS / Android 原生发包，免受任何同源策略拦截）
    if (this._isCapacitorNative()) {
      return this._requestCapacitor({ url, method, headers: finalHeaders, body, responseType, timeout: effectiveTimeout });
    }

    // 默认使用浏览器 fetch
    return this._requestFetch({ url, method, headers: finalHeaders, body, responseType, timeout: effectiveTimeout });
  }

  async _requestFetch({ url, method, headers, body, responseType, timeout = null, fetchFn = null }) {
    const activeFetch = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    if (!activeFetch) throw new Error('No fetch implementation available');

    const effectiveTimeout = timeout || this.timeout;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), effectiveTimeout) : null;

    try {
      const fetchOptions = {
        method,
        headers,
        signal: controller ? controller.signal : undefined
      };

      if (body !== null && method !== 'GET' && method !== 'HEAD') {
        fetchOptions.body = body;
      }

      let res = await activeFetch(url, fetchOptions);

      // 若使用 HTTP 遇到 401，且目标服务器可能为强制 HTTPS 跳转（浏览器重定向会根据规范丢弃 Authorization 头）
      if (res.status === 401 && url.startsWith('http://')) {
        const httpsUrl = 'https://' + url.slice(7);
        try {
          const retryRes = await activeFetch(httpsUrl, fetchOptions);
          if (retryRes && (retryRes.ok || retryRes.status !== 401)) {
            res = retryRes;
            if (this.endpoint.startsWith('http://')) {
              this.endpoint = 'https://' + this.endpoint.slice(7);
            }
          }
        } catch (_) {}
      }

      if (timer) clearTimeout(timer);

      let data;
      if (responseType === 'json') {
        data = await res.json();
      } else if (responseType === 'blob') {
        data = await res.blob();
      } else if (responseType === 'arraybuffer') {
        data = await res.arrayBuffer();
      } else {
        data = await res.text();
      }

      return {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        data,
        ok: res.ok
      };
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error(`WebDAV request timeout (${effectiveTimeout}ms) for ${method} ${url}`);
      }
      throw err;
    }
  }

  // 高性能低内存 Blob -> Base64 转换 (避免百万级 JS 字符串拼接导致 iOS WebKit OOM)
  async _blobToBase64(blob) {
    if (typeof FileReader !== 'undefined') {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const res = reader.result;
          if (typeof res === 'string') {
            const commaIdx = res.indexOf(',');
            resolve(commaIdx >= 0 ? res.slice(commaIdx + 1) : res);
          } else {
            resolve('');
          }
        };
        reader.onerror = (e) => reject(reader.error || e);
        reader.readAsDataURL(blob);
      });
    }

    // Node.js 或 Worker 降级环境：32KB 分块处理，避免调用栈溢出或内存暴涨
    const arrayBuf = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    const CHUNK_SIZE = 32768;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, i + CHUNK_SIZE);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  // 高性能低内存 Base64 -> Blob 转换 (直接使用 Uint8Array，严禁使用 new Array(len))
  _base64ToBlob(base64Str, mimeType = 'application/octet-stream') {
    const binary = atob(base64Str);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }

  async _requestCapacitor({ url, method, headers, body, responseType, timeout = null }) {
    const CapHttp = window.Capacitor.Plugins.CapacitorHttp;
    const effectiveTimeout = timeout || this.timeout;

    let payloadData = body;
    let dataType = undefined;

    // 如果是 Blob，转为 Base64 供 Capacitor 传输并声明 dataType 为 file
    if (body instanceof Blob) {
      payloadData = await this._blobToBase64(body);
      dataType = 'file';
      headers['Content-Type'] = headers['Content-Type'] || body.type || 'application/octet-stream';
    }

    const options = {
      url,
      method,
      headers,
      data: payloadData,
      connectTimeout: effectiveTimeout,
      readTimeout: effectiveTimeout,
      responseType: (responseType === 'blob' || responseType === 'arraybuffer') ? 'arraybuffer' : 'text'
    };

    if (dataType) {
      options.dataType = dataType;
    }

    let res;
    try {
      res = await CapHttp.request(options);
    } finally {
      // 显式清理大数据引用，协助 iOS 垃圾回收
      payloadData = null;
      options.data = null;
    }
    let resultData = res.data;

    if (responseType === 'json' && typeof resultData === 'string') {
      try {
        resultData = JSON.parse(resultData);
      } catch (e) {}
    } else if (responseType === 'blob' && (resultData instanceof ArrayBuffer || typeof resultData === 'string')) {
      if (typeof resultData === 'string') {
        resultData = this._base64ToBlob(resultData, res.headers?.['content-type'] || 'application/octet-stream');
      } else {
        resultData = new Blob([resultData]);
      }
    } else if (responseType === 'arraybuffer' && typeof resultData === 'string') {
      const binary = atob(resultData);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      resultData = bytes.buffer;
    }

    return {
      status: res.status,
      statusText: String(res.status),
      headers: res.headers || {},
      data: resultData,
      ok: res.status >= 200 && res.status < 300
    };
  }

  // 检查远端文件或目录是否存在
  async exists(relativePath = '') {
    const url = this.buildUrl(relativePath);
    try {
      const res = await this.request({
        url,
        method: 'PROPFIND',
        headers: {
          'Depth': '0',
          'Content-Type': 'application/xml; charset=utf-8'
        }
      });
      return res.status === 207 || (res.status >= 200 && res.status < 300);
    } catch (e) {
      return false;
    }
  }

  // 创建单级目录 (MKCOL)
  async mkcol(relativePath = '') {
    const url = this.buildUrl(relativePath);
    const res = await this.request({
      url: url.endsWith('/') ? url : url + '/',
      method: 'MKCOL'
    });
    // 201 Created 或 405 Method Not Allowed (已存在) 均视为正常
    if (res.status === 201 || res.status === 405) {
      return true;
    }
    throw new Error(this._formatHttpError('MKCOL', relativePath, res.status, res.statusText));
  }

  // 递归逐级创建远端目录 (例如 /EdgeReader/records/subdir)
  async ensureDir(relativePath = '') {
    let clean = relativePath.trim().replace(/\\/g, '/');
    if (!clean.startsWith('/')) clean = '/' + clean;
    clean = clean.replace(/\/+$/, '');

    const fullPath = this.remotePath + (clean === '/' ? '' : clean);
    const parts = fullPath.split('/').filter(Boolean);

    let current = '';
    for (const part of parts) {
      current += '/' + part;
      // 检查该级目录是否存在
      const dirUrl = `${this.endpoint}${current.split('/').map(encodeURIComponent).join('/')}/`;
      try {
        const checkRes = await this.request({
          url: dirUrl,
          method: 'PROPFIND',
          headers: { 'Depth': '0' }
        });
        if (checkRes.status === 207 || (checkRes.status >= 200 && checkRes.status < 300)) {
          continue; // 已存在
        }
      } catch (e) {
        // 请求失败，尝试创建
      }

      // 执行 MKCOL
      try {
        const mkRes = await this.request({
          url: dirUrl,
          method: 'MKCOL'
        });
        if (mkRes.status !== 201 && mkRes.status !== 405) {
          console.warn(`[WebDAV] MKCOL on ${dirUrl} returned ${mkRes.status}`);
        }
      } catch (err) {
        console.warn(`[WebDAV] Failed to create folder ${dirUrl}:`, err);
      }
    }
    return true;
  }

  // 列举目录内容 (PROPFIND Depth: 1)
  async listDir(relativePath = '') {
    const url = this.buildUrl(relativePath);
    const targetUrl = url.endsWith('/') ? url : url + '/';

    const res = await this.request({
      url: targetUrl,
      method: 'PROPFIND',
      headers: {
        'Depth': '1',
        'Content-Type': 'application/xml; charset=utf-8'
      },
      responseType: 'text'
    });

    if (res.status !== 207 && !(res.status >= 200 && res.status < 300)) {
      throw new Error(`PROPFIND failed with status ${res.status}`);
    }

    return this._parsePropfindXml(res.data, targetUrl);
  }

  // 解析 WebDAV 207 Multi-Status XML 响应
  _parsePropfindXml(xmlText, requestUrl) {
    if (!xmlText) return [];
    const items = [];

    // 采用通用正则表达式提取 response 节点，兼容浏览器与无 DOMParser 的测试环境
    const responseRegex = /<(?:\w+:)?response[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/gi;
    let match;

    while ((match = responseRegex.exec(xmlText)) !== null) {
      const respContent = match[1];

      // href
      const hrefMatch = /<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/i.exec(respContent);
      let href = hrefMatch ? hrefMatch[1].trim() : '';

      // displayName
      const nameMatch = /<(?:\w+:)?displayname[^>]*>([\s\S]*?)<\/(?:\w+:)?displayname>/i.exec(respContent);
      let displayName = nameMatch ? nameMatch[1].trim() : '';

      // isCollection (目录)
      const isCollection = /<(?:\w+:)?collection\s*\/?>(?:<\/(?:\w+:)?collection>)?/i.test(respContent);

      // getcontentlength
      const lenMatch = /<(?:\w+:)?getcontentlength[^>]*>([\s\S]*?)<\/(?:\w+:)?getcontentlength>/i.exec(respContent);
      const size = lenMatch ? parseInt(lenMatch[1].trim(), 10) || 0 : 0;

      // getlastmodified
      const modMatch = /<(?:\w+:)?getlastmodified[^>]*>([\s\S]*?)<\/(?:\w+:)?getlastmodified>/i.exec(respContent);
      const lastModified = modMatch ? new Date(modMatch[1].trim()).getTime() || 0 : 0;

      // etag
      const etagMatch = /<(?:\w+:)?getetag[^>]*>([\s\S]*?)<\/(?:\w+:)?getetag>/i.exec(respContent);
      const etag = etagMatch ? etagMatch[1].trim().replace(/^"|"$/g, '') : '';

      // 解码 URL 路径并提取文件名
      try {
        const decodedHref = decodeURIComponent(href);
        const cleanHref = decodedHref.replace(/\/+$/, '');
        const filename = cleanHref.substring(cleanHref.lastIndexOf('/') + 1);
        if (!displayName) displayName = filename;
      } catch (e) {
        if (!displayName) displayName = href;
      }

      // 过滤掉当前查询的根目录自身
      const normalizedReq = requestUrl.replace(/^https?:\/\/[^\/]+/, '').replace(/\/+$/, '');
      const normalizedHref = href.replace(/^https?:\/\/[^\/]+/, '').replace(/\/+$/, '');
      if (decodeURIComponent(normalizedHref) === decodeURIComponent(normalizedReq)) {
        continue;
      }

      items.push({
        href,
        displayName,
        isCollection,
        size,
        lastModified,
        etag
      });
    }

    return items;
  }

  // 上传文件 (PUT)
  async putFile(relativePath, data, contentType = 'application/octet-stream', options = {}) {
    // 自动确保父级目录存在
    const cleanRel = relativePath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    const lastSlash = cleanRel.lastIndexOf('/');
    if (lastSlash > 0) {
      const parentDir = cleanRel.substring(0, lastSlash);
      await this.ensureDir(parentDir);
    }

    const url = this.buildUrl(relativePath);
    const headers = {
      'Content-Type': contentType,
      ...(options.headers || {})
    };

    let bodyData = data;
    if (typeof data === 'object' && !(data instanceof Blob) && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      bodyData = JSON.stringify(data, null, 2);
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }

    // 自适应超时：对于超过 10MB 的大文件（如 70MB~100MB+），自动延长超时到 300 秒 (5分钟)
    let timeout = options.timeout;
    if (!timeout && data instanceof Blob && data.size > 10 * 1024 * 1024) {
      timeout = 300000;
    }

    const res = await this.request({
      url,
      method: 'PUT',
      headers,
      body: bodyData,
      responseType: 'text',
      timeout
    });

    if (res.status === 200 || res.status === 201 || res.status === 204) {
      return true;
    }
    throw new Error(this._formatHttpError('PUT', relativePath, res.status, res.statusText));
  }

  // 获取文件内容 (GET)
  async getFile(relativePath, responseType = 'text', options = {}) {
    const url = this.buildUrl(relativePath);
    let timeout = options.timeout;
    if (!timeout && (responseType === 'blob' || responseType === 'arraybuffer')) {
      timeout = 300000; // 二进制拉取默认放宽超时到 5 分钟
    }

    const res = await this.request({
      url,
      method: 'GET',
      responseType,
      timeout
    });

    if (res.status === 200) {
      return res.data;
    }
    if (res.status === 404) {
      return null;
    }
    throw new Error(this._formatHttpError('GET', relativePath, res.status, res.statusText));
  }

  // 删除文件或目录 (DELETE)
  async deleteFile(relativePath) {
    const url = this.buildUrl(relativePath);
    const res = await this.request({
      url,
      method: 'DELETE'
    });
    // 200, 204 或 404（本就不存在）均视为删除成功
    return res.status === 200 || res.status === 204 || res.status === 404;
  }

  // 自检连接性与读写鉴权
  async testConnection() {
    if (!this.endpoint) {
      throw new Error('WebDAV 服务地址不能为空');
    }

    const startTime = Date.now();

    // 1. 测试根路径连通性与账号密码鉴权
    const rootUrl = this.endpoint + '/';
    let rootRes;
    try {
      rootRes = await this.request({
        url: rootUrl,
        method: 'PROPFIND',
        headers: { 'Depth': '0' }
      });
    } catch (netErr) {
      throw new Error(`网络连接失败或跨域受限 (CORS): ${netErr.message || netErr}`);
    }

    if (rootRes.status === 401 || rootRes.status === 403) {
      throw new Error(`WebDAV 认证失败 (${rootRes.status}): 请检查用户名与密码/应用令牌`);
    }

    // 2. 测试远端应用根目录创建与读写
    await this.ensureDir('');

    const testFile = `_ping_${Date.now()}.tmp`;
    const testPayload = JSON.stringify({ ping: 'ok', timestamp: Date.now() });

    try {
      // 写入测试文件
      await this.putFile(testFile, testPayload, 'application/json');
      // 读取测试文件校验内容
      const readBack = await this.getFile(testFile, 'text');
      if (!readBack || !readBack.includes('ping')) {
        throw new Error('写入的文件读取校验不一致');
      }
      // 清理测试文件
      await this.deleteFile(testFile);
    } catch (rwErr) {
      throw new Error(`WebDAV 读写权限受限: ${rwErr.message || rwErr}`);
    }

    const duration = Date.now() - startTime;
    return {
      success: true,
      latency: duration,
      message: `连接成功！响应延迟: ${duration}ms`
    };
  }
}
