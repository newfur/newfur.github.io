const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');

const ROOT = __dirname;
const TTS_ENDPOINT = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_VERSION = '1-143.0.3650.75';
const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const EDGE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';

const defaultConfig = Object.freeze({
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
  allowedOrigins: null,
  allowNonBrowser: false,
  maxPayload: 1024 * 1024,
  maxClients: 16,
  maxQueueMessages: 32,
  maxQueueBytes: 256 * 1024,
  maxBufferedBytes: 1024 * 1024,
  upstreamConnectTimeoutMs: 10000,
  idleTimeoutMs: 60000,
  voicesTimeoutMs: 10000
});

const STATIC_MOUNTS = [
  { prefix: '/reader/', root: path.join(ROOT, 'reader') },
  { prefix: '/_locales/', root: path.join(ROOT, '_locales') },
  { prefix: '/icons/', root: path.join(ROOT, 'icons') }
];
const ROOT_FILES = new Map([
  ['/manifest.json', path.join(ROOT, 'manifest.json')]
]);

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function decodePathname(rawPathname) {
  let decoded = rawPathname;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) return decoded;
    decoded = next;
  }
  if (decoded.includes('%')) throw new URIError('Excessive encoding');
  return decoded;
}

function resolveStaticTarget(rawPathname, staticMounts = STATIC_MOUNTS, rootFiles = ROOT_FILES) {
  let pathname;
  try {
    pathname = decodePathname(rawPathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  pathname = pathname.replace(/\\/g, '/');

  const segments = pathname.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.' || segment.startsWith('.'))) {
    return null;
  }

  const rootFile = rootFiles.get(pathname);
  if (rootFile) return { filePath: rootFile, root: path.dirname(rootFile) };

  const mount = staticMounts.find(({ prefix }) => pathname.startsWith(prefix));
  if (!mount) return null;
  const relativePath = pathname.slice(mount.prefix.length);
  if (!relativePath) return null;
  const candidate = path.resolve(mount.root, relativePath);
  return isWithin(mount.root, candidate) ? { filePath: candidate, root: mount.root } : null;
}

function resolveStaticPath(rawPathname, staticMounts = STATIC_MOUNTS, rootFiles = ROOT_FILES) {
  return resolveStaticTarget(rawPathname, staticMounts, rootFiles)?.filePath || null;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function anchorStaticMounts(staticMounts) {
  return staticMounts.map(({ prefix, root }) => {
    const absoluteRoot = path.resolve(root);
    try {
      const realRoot = fs.realpathSync(absoluteRoot);
      return {
        prefix,
        root: absoluteRoot,
        realRoot,
        rootIdentity: fs.lstatSync(absoluteRoot),
        realRootIdentity: fs.lstatSync(realRoot)
      };
    } catch {
      return { prefix, root: absoluteRoot, usable: false };
    }
  });
}

function validateConfig(config, allowZeroPort) {
  if (typeof config.host !== 'string' || config.host.trim() === '') {
    throw new TypeError('Invalid server config: host must be a nonempty string');
  }
  if (!Number.isInteger(config.port) || config.port < (allowZeroPort ? 0 : 1) || config.port > 65535) {
    throw new TypeError('Invalid server config: port must be an integer from 1 to 65535');
  }
  for (const name of ['maxClients', 'maxPayload', 'maxQueueMessages', 'maxQueueBytes', 'maxBufferedBytes']) {
    if (!Number.isInteger(config[name]) || config[name] <= 0) {
      throw new TypeError(`Invalid server config: ${name} must be a positive integer`);
    }
  }
  for (const name of ['upstreamConnectTimeoutMs', 'idleTimeoutMs', 'voicesTimeoutMs']) {
    if (!Number.isFinite(config[name]) || config[name] <= 0) {
      throw new TypeError(`Invalid server config: ${name} must be positive and finite`);
    }
  }
  if (config.allowedOrigins != null && !Array.isArray(config.allowedOrigins)) {
    throw new TypeError('Invalid server config: allowedOrigins must be an array or null');
  }
  return config;
}

function rawPathname(requestUrl) {
  const end = requestUrl.search(/[?#]/);
  return end === -1 ? requestUrl : requestUrl.slice(0, end);
}

function sendText(res, statusCode, body, headers = {}) {
  if (res.destroyed || res.writableEnded || res.headersSent) return false;
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
  return true;
}

function createRequestHandler(options = {}) {
  const voiceRequest = options.voiceRequest || https.request;
  const staticMounts = anchorStaticMounts(options.staticMounts || STATIC_MOUNTS);
  const rootFiles = options.rootFiles || ROOT_FILES;
  const beforeOpen = options.beforeOpen;
  const createStaticStream = options.createStaticStream || ((file) => file.createReadStream({ autoClose: false }));
  const voicesTimeoutMs = options.voicesTimeoutMs || defaultConfig.voicesTimeoutMs;
  return function handleRequest(req, res) {
    const pathname = rawPathname(req.url || '/');

    if (pathname === '/api/voices') {
      let settled = false;
      let apiReq;
      let apiRes;
      let timer;
      function finish(statusCode, body) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (apiRes && typeof apiRes.destroy === 'function') apiRes.destroy();
        if (apiReq && typeof apiReq.destroy === 'function' && !apiReq.destroyed) apiReq.destroy();
        if (!res.destroyed && !res.writableEnded) sendText(res, statusCode, body);
      }
      function cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (apiRes && typeof apiRes.destroy === 'function') apiRes.destroy();
        if (apiReq && typeof apiReq.destroy === 'function' && !apiReq.destroyed) apiReq.destroy();
      }
      res.once('close', cancel);
      req.once('aborted', cancel);
      apiReq = voiceRequest('https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=' + TRUSTED_CLIENT_TOKEN, {
        method: 'GET',
        headers: { Origin: EDGE_ORIGIN, 'User-Agent': EDGE_USER_AGENT }
      }, (upstreamResponse) => {
        if (settled) {
          upstreamResponse.destroy();
          return;
        }
        apiRes = upstreamResponse;
        const chunks = [];
        upstreamResponse.on('data', (chunk) => chunks.push(chunk));
        upstreamResponse.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          res.writeHead(upstreamResponse.statusCode || 502, {
            'Content-Type': 'application/json; charset=utf-8',
            'x-server-date': upstreamResponse.headers.date || '',
            'Access-Control-Expose-Headers': 'x-server-date'
          });
          res.end(Buffer.concat(chunks));
        });
        upstreamResponse.on('error', () => finish(502, 'Upstream request failed'));
      });
      apiReq.on('error', () => finish(502, 'Upstream request failed'));
      timer = setTimeout(() => finish(504, 'Upstream request timed out'), voicesTimeoutMs);
      apiReq.end();
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(302, { Location: '/reader/reader.html' });
      res.end();
      return;
    }

    const staticPathname = pathname === '/favicon.ico' ? '/icons/icon16.png' : pathname;
    const target = resolveStaticTarget(staticPathname, staticMounts, rootFiles);
    const mount = staticMounts.find(({ root }) => root === target?.root);
    if (!target || (mount && mount.usable === false)) {
      sendText(res, 404, '404 Not Found');
      return;
    }

    Promise.all([
      fs.promises.lstat(target.root),
      mount ? fs.promises.lstat(mount.realRoot) : null,
      fs.promises.realpath(target.filePath)
    ]).then(async ([currentRootIdentity, currentRealRootIdentity, realFilePath]) => {
      const realRoot = mount?.realRoot || fs.realpathSync(target.root);
      const rootIdentity = mount?.rootIdentity;
      if (
        (rootIdentity && !sameFileIdentity(rootIdentity, currentRootIdentity)) ||
        (mount && !sameFileIdentity(mount.realRootIdentity, currentRealRootIdentity)) ||
        !isWithin(realRoot, realFilePath)
      ) {
        sendText(res, 404, '404 Not Found');
        return;
      }
      let file;
      try {
        const expectedStats = await fs.promises.lstat(realFilePath);
        if (!expectedStats.isFile()) {
          sendText(res, 404, '404 Not Found');
          return;
        }
        if (beforeOpen) await beforeOpen(realFilePath);
        file = await fs.promises.open(realFilePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const openedStats = await file.stat();
        if (!openedStats.isFile() || !sameFileIdentity(expectedStats, openedStats)) {
          await file.close();
          sendText(res, 404, '404 Not Found');
          return;
        }
        // Node has no portable openat. Recheck both anchored roots around open and bind
        // the validated file to its descriptor identity to narrow, not eliminate, races.
        const [postRootIdentity, postRealRootIdentity] = await Promise.all([
          fs.promises.lstat(target.root),
          mount ? fs.promises.lstat(mount.realRoot) : null
        ]);
        if (
          (rootIdentity && !sameFileIdentity(rootIdentity, postRootIdentity)) ||
          (mount && !sameFileIdentity(mount.realRootIdentity, postRealRootIdentity))
        ) {
          await file.close();
          sendText(res, 404, '404 Not Found');
          return;
        }
      } catch {
        if (file) await file.close().catch(() => {});
        sendText(res, 404, '404 Not Found');
        return;
      }
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.wasm': 'application/wasm'
      };
      let stream;
      try {
        stream = createStaticStream(file);
      } catch {
        await file.close().catch(() => {});
        sendText(res, 404, '404 Not Found');
        return;
      }
      let cleaned = false;
      async function cleanup() {
        if (cleaned) return;
        cleaned = true;
        if (!stream.destroyed) stream.destroy();
        await file.close().catch(() => {});
      }
      res.once('close', cleanup);
      res.once('finish', cleanup);
      res.once('error', cleanup);
      stream.once('error', () => {
        cleanup();
        res.destroy();
      });
      stream.once('end', cleanup);
      stream.once('close', cleanup);
      res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(realFilePath).toLowerCase()] || 'application/octet-stream' });
      stream.pipe(res);
    }).catch(() => sendText(res, 404, '404 Not Found'));
  };
}

function buildUpstreamUrl(requestUrl) {
  const incoming = new URL(requestUrl, 'http://localhost');
  const target = new URL(TTS_ENDPOINT);
  for (const name of ['ConnectionId', 'Sec-MS-GEC']) {
    const value = incoming.searchParams.get(name);
    if (value !== null) target.searchParams.set(name, value);
  }
  target.searchParams.set('TrustedClientToken', TRUSTED_CLIENT_TOKEN);
  target.searchParams.set('Sec-MS-GEC-Version', EDGE_VERSION);
  return target.toString();
}

function rejectUpgrade(socket, statusCode, statusText) {
  socket.end(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function createServer(overrides = {}) {
  const config = validateConfig(
    { ...defaultConfig, ...overrides },
    Object.prototype.hasOwnProperty.call(overrides, 'port')
  );
  const upstreamFactory = config.upstreamFactory || ((targetUrl) => new WebSocket(targetUrl, {
    headers: { Origin: EDGE_ORIGIN, 'User-Agent': EDGE_USER_AGENT }
  }));
  const server = http.createServer(createRequestHandler({
    voiceRequest: config.voiceRequest,
    staticMounts: config.staticMounts,
    rootFiles: config.rootFiles,
    voicesTimeoutMs: config.voicesTimeoutMs
  }));
  const wss = new WebSocket.Server({ noServer: true, maxPayload: config.maxPayload });
  let activeClients = 0;
  let pendingUpgrades = 0;

  server.on('upgrade', (req, socket, head) => {
    let parsed;
    try {
      parsed = new URL(req.url, 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (parsed.pathname !== '/api/tts') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const address = server.address();
    const port = address && address.port ? address.port : config.port;
    const allowedOrigins = new Set(config.allowedOrigins ?? [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`
    ]);
    const origin = req.headers.origin;
    if ((!origin && !config.allowNonBrowser) || (origin && !allowedOrigins.has(origin))) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (activeClients + pendingUpgrades >= config.maxClients) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    pendingUpgrades += 1;
    let pending = true;
    function releasePending() {
      if (!pending) return;
      pending = false;
      pendingUpgrades -= 1;
    }
    socket.once('close', releasePending);
    socket.once('error', releasePending);
    try {
      wss.handleUpgrade(req, socket, head, (client) => {
        if (!pending) {
          client.terminate();
          return;
        }
        releasePending();
        socket.removeListener('close', releasePending);
        socket.removeListener('error', releasePending);
        activeClients += 1;
        wss.emit('connection', client, req);
      });
    } catch {
      releasePending();
      socket.destroy();
    }
  });

  wss.on('connection', (client, req) => {
    let upstream;
    let cleaned = false;
    let upstreamOpen = false;
    let queuedBytes = 0;
    const queue = [];
    let connectTimer;
    let idleTimer;

    function closePeer(peer, code, reason) {
      if (!peer || peer.readyState === WebSocket.CLOSED || peer.readyState === WebSocket.CLOSING) return;
      if (peer.readyState === WebSocket.CONNECTING && typeof peer.terminate === 'function') {
        peer.terminate();
      } else {
        peer.close(code, reason);
      }
    }

    function cleanup(code = 1000, reason = '') {
      if (cleaned) return;
      cleaned = true;
      activeClients -= 1;
      clearTimeout(connectTimer);
      clearTimeout(idleTimer);
      queue.length = 0;
      closePeer(client, code, reason);
      closePeer(upstream, code, reason);
    }

    function resetIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => cleanup(1008, 'Idle timeout'), config.idleTimeoutMs);
    }

    function boundedSend(destination, data, isBinary) {
      const bytes = Buffer.byteLength(data);
      if (destination.bufferedAmount + bytes > config.maxBufferedBytes) {
        cleanup(1009, 'Backpressure limit exceeded');
        return false;
      }
      destination.send(data, { binary: isBinary });
      return true;
    }

    try {
      upstream = upstreamFactory(buildUpstreamUrl(req.url), req);
    } catch {
      cleanup(1011, 'Upstream unavailable');
      return;
    }

    connectTimer = setTimeout(() => cleanup(1008, 'Upstream connect timeout'), config.upstreamConnectTimeoutMs);
    resetIdle();

    upstream.on('open', () => {
      if (cleaned) return;
      upstreamOpen = true;
      clearTimeout(connectTimer);
      resetIdle();
      while (queue.length && !cleaned) {
        const item = queue.shift();
        queuedBytes -= item.bytes;
        boundedSend(upstream, item.data, item.isBinary);
      }
    });

    client.on('message', (data, isBinary) => {
      if (cleaned) return;
      resetIdle();
      if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
        boundedSend(upstream, data, isBinary);
        return;
      }
      const bytes = Buffer.byteLength(data);
      if (queue.length >= config.maxQueueMessages) {
        cleanup(1008, 'Queue message limit exceeded');
      } else if (queuedBytes + bytes > config.maxQueueBytes) {
        cleanup(1009, 'Queue byte limit exceeded');
      } else {
        queue.push({ data, isBinary, bytes });
        queuedBytes += bytes;
      }
    });

    upstream.on('message', (data, isBinary) => {
      if (cleaned) return;
      resetIdle();
      if (client.readyState === WebSocket.OPEN) boundedSend(client, data, isBinary);
    });
    client.on('close', () => cleanup());
    upstream.on('close', () => cleanup());
    client.on('error', () => cleanup(1011, 'Client error'));
    upstream.on('error', () => cleanup(1011, 'Upstream error'));
  });

  return {
    server,
    wss,
    config,
    get activeClients() { return activeClients; }
  };
}

if (require.main === module) {
  const { server, config } = createServer();
  server.listen(config.port, config.host, () => {
    console.log('====================================================');
    console.log('Raconteur/读书人 Web Version running at:');
    console.log(`http://${config.host}:${config.port}/`);
    console.log('====================================================');
  });
}

module.exports = {
  buildUpstreamUrl,
  createRequestHandler,
  createServer,
  defaultConfig,
  isWithin,
  resolveStaticPath
};
