const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const https = require('https');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

function getSecMsGec() {
  const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const WIN_EPOCH = 11644473600;
  let unixSeconds = Math.floor(Date.now() / 1000) + WIN_EPOCH;
  unixSeconds -= (unixSeconds % 300);
  const ticks = BigInt(unixSeconds) * 10000000n;
  const strToHash = ticks.toString() + TRUSTED_CLIENT_TOKEN;
  return crypto.createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;

  // Route API for voices list
  if (pathname === '/api/voices') {
    const secMsGec = getSecMsGec();
    const primaryUrl = `https://api.msedgeservices.com/tts/cognitiveservices/voices/list?Ocp-Apim-Subscription-Key=6A5AA1D4EAFF4E9FB37E23D68491D6F4&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-143.0.3650.75`;
    const fallbackUrl = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';

    const fetchVoices = (targetUrl, isFallback = false) => {
      const apiReq = https.request(targetUrl, {
        method: 'GET',
        headers: {
          'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
        }
      }, (apiRes) => {
        if (!isFallback && apiRes.statusCode !== 200) {
          return fetchVoices(fallbackUrl, true);
        }
        const serverDate = apiRes.headers['date'];
        let rawData = '';
        apiRes.on('data', (chunk) => { rawData += chunk; });
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
            'x-server-date': serverDate || '',
            'Access-Control-Expose-Headers': 'x-server-date'
          });
          res.end(rawData);
        });
      });
      apiReq.on('error', (e) => {
        if (!isFallback) {
          return fetchVoices(fallbackUrl, true);
        }
        console.error(`Problem with request: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Proxy error: ${e.message}`);
      });
      apiReq.end();
    };

    fetchVoices(primaryUrl);
    return;
  }

  // Redirect root to /reader/reader.html
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(302, { 'Location': '/reader/reader.html' });
    res.end();
    return;
  }

  // Handle favicon
  if (pathname === '/favicon.ico') {
    pathname = '/icons/icon16.png';
  }

  // Resolve safe local file path
  const isAllowedDir = pathname.startsWith('/reader/') || pathname.startsWith('/_locales/') || pathname.startsWith('/icons/');
  if (!isAllowedDir) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  const localFilePath = path.join(__dirname, pathname);
  
  // Safe check against directory traversal
  const relative = path.relative(__dirname, localFilePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(localFilePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    // Determine content type
    const ext = path.extname(localFilePath).toLowerCase();
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
    
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    
    // Stream file response
    const readStream = fs.createReadStream(localFilePath);
    readStream.pipe(res);
  });
}

const server = http.createServer(handleRequest);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  if (parsedUrl.pathname === '/api/tts') {
    const query = parsedUrl.search || '';
    const targetUrl = `wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1${query}&Ocp-Apim-Subscription-Key=6A5AA1D4EAFF4E9FB37E23D68491D6F4&Sec-MS-GEC-Version=1-143.0.3650.75`;
    
    const targetWs = new WebSocket(targetUrl, {
      headers: {
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
      }
    });

    const msgQueue = [];
    let targetWsOpen = false;

    targetWs.on('open', () => {
      targetWsOpen = true;
      while (msgQueue.length > 0) {
        const { message, isBinary } = msgQueue.shift();
        targetWs.send(message, { binary: isBinary });
      }
    });

    ws.on('message', (message, isBinary) => {
      if (targetWsOpen) {
        if (targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(message, { binary: isBinary });
        }
      } else {
        msgQueue.push({ message, isBinary });
      }
    });

    ws.on('close', () => {
      targetWs.close();
    });

    targetWs.on('message', (data, isBinary) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data, { binary: isBinary });
      }
    });

    targetWs.on('close', () => {
      ws.close();
    });

    targetWs.on('error', (err) => {
      console.error('Target Edge TTS WS error:', err);
      ws.close();
    });

    ws.on('error', (err) => {
      console.error('Client WS proxy error:', err);
      targetWs.close();
    });
  } else {
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`Raconteur/读书人 Web Version running at:`);
  console.log(`http://localhost:${PORT}/`);
  console.log(`====================================================`);
});
