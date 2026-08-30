import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const { createServer, defaultConfig, resolveStaticPath } = require('../../server.js');

class FakeUpstream extends EventEmitter {
  constructor({ open = true } = {}) {
    super();
    this.readyState = WebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.sent = [];
    if (open) {
      queueMicrotask(() => {
        this.readyState = WebSocket.OPEN;
        this.emit('open');
      });
    }
  }

  send(data, options) {
    const item = { data: Buffer.from(data), options };
    this.sent.push(item);
    this.emit('sent', item);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit('close', code, Buffer.from(reason)));
  }

  terminate() {
    this.close(1006);
  }
}

async function start(overrides = {}) {
  const upstreams = [];
  const urls = [];
  const upstreamFactory = overrides.upstreamFactory || ((url) => {
    urls.push(url);
    const upstream = new FakeUpstream();
    upstreams.push(upstream);
    return upstream;
  });
  const app = createServer({
    ...overrides,
    upstreamFactory
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  return {
    ...app,
    get activeClients() { return app.activeClients; },
    port,
    origin: `http://127.0.0.1:${port}`,
    upstreams,
    urls,
    async close() {
      for (const client of app.wss.clients) client.terminate();
      await new Promise((resolve) => app.server.close(resolve));
    }
  };
}

function request(app, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: app.port,
      path: requestPath,
      method: 'GET'
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks),
        headers: res.headers
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function openClient(app, path = '/api/tts?ConnectionId=abc&Sec-MS-GEC=def', origin) {
  if (arguments.length < 3) origin = app.origin;
  const headers = origin === undefined ? {} : { Origin: origin };
  return new WebSocket(`ws://127.0.0.1:${app.port}${path}`, { headers });
}

async function expectRejected(ws, expectedStatus) {
  const [, res] = await once(ws, 'unexpected-response');
  assert.equal(res.statusCode, expectedStatus);
  res.resume();
}

async function expectClose(ws, expectedCode) {
  const [code] = await once(ws, 'close');
  assert.equal(code, expectedCode);
}

test('requiring server exports helpers without automatically listening', () => {
  assert.equal(typeof createServer, 'function');
  assert.equal(typeof resolveStaticPath, 'function');
  assert.equal(defaultConfig.host, '127.0.0.1');
});

test('serves a valid file from an exact static mount', async (t) => {
  const app = await start();
  t.after(() => app.close());
  const response = await request(app, '/reader/reader.html');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /^text\/html/);
  assert.ok(response.body.length > 100);
});

test('rejects traversal, encoding, backslash, mount crossover, and sensitive paths', async (t) => {
  const app = await start();
  t.after(() => app.close());
  const attacks = [
    '/reader/../server.js',
    '/reader/%2e%2e/server.js',
    '/reader/%2E%2E%2fserver.js',
    '/reader/%252e%252e/server.js',
    '/reader/..%5cserver.js',
    '/reader/%5c..%5cserver.js',
    '/reader/../icons/icon16.png',
    '/reader/%2e%2e/_locales/en/messages.json',
    '/.git/config',
    '/reader/.secret',
    '/reader/%00reader.html',
    '/reader/%E0%A4%A'
  ];
  for (const attack of attacks) {
    const response = await request(app, attack);
    assert.notEqual(response.statusCode, 200, attack);
  }
});

test('rejects the wrong websocket path before creating an upstream', async (t) => {
  const app = await start();
  t.after(() => app.close());
  const ws = openClient(app, '/api/other');
  await expectRejected(ws, 404);
  assert.equal(app.upstreams.length, 0);
});

test('rejects wrong and missing browser origins', async (t) => {
  const app = await start();
  t.after(() => app.close());
  await expectRejected(openClient(app, '/api/tts', 'https://evil.example'), 403);
  await expectRejected(openClient(app, '/api/tts', undefined), 403);
  assert.equal(app.upstreams.length, 0);
});

test('accepts generated localhost reader origins', async (t) => {
  const app = await start();
  t.after(() => app.close());
  for (const hostname of ['127.0.0.1', 'localhost']) {
    const ws = openClient(app, '/api/tts', `http://${hostname}:${app.port}`);
    await once(ws, 'open');
    ws.close();
    await once(ws, 'close');
  }
});

test('closes oversized websocket payloads with 1009', async (t) => {
  const app = await start({ maxPayload: 8 });
  t.after(() => app.close());
  const ws = openClient(app);
  await once(ws, 'open');
  ws.send('123456789');
  await expectClose(ws, 1009);
});

test('caps queued messages and queued bytes before upstream opens', async (t) => {
  const upstreams = [];
  const app = await start({
    maxQueuedMessages: 1,
    maxQueuedBytes: 5,
    upstreamFactory() {
      const upstream = new FakeUpstream({ open: false });
      upstreams.push(upstream);
      return upstream;
    }
  });
  t.after(() => app.close());

  const countClient = openClient(app);
  await once(countClient, 'open');
  countClient.send('a');
  countClient.send('b');
  await expectClose(countClient, 1008);

  const byteClient = openClient(app);
  await once(byteClient, 'open');
  byteClient.send('123456');
  await expectClose(byteClient, 1009);
  assert.equal(upstreams.length, 2);
});

test('caps concurrent relay clients', async (t) => {
  const app = await start({ maxClients: 1 });
  t.after(() => app.close());
  const first = openClient(app);
  await once(first, 'open');
  const second = openClient(app);
  await expectRejected(second, 503);
  const firstUpstreamClosed = once(app.upstreams[0], 'close');
  first.close();
  await Promise.all([once(first, 'close'), firstUpstreamClosed]);
  assert.equal(app.activeClients, 0);

  const replacement = openClient(app);
  await once(replacement, 'open');
  const replacementUpstreamClosed = once(app.upstreams[1], 'close');
  replacement.close();
  await Promise.all([once(replacement, 'close'), replacementUpstreamClosed]);
  assert.equal(app.activeClients, 0);
});

test('closes when the upstream connection times out', async (t) => {
  const app = await start({
    upstreamConnectTimeoutMs: 15,
    upstreamFactory: () => new FakeUpstream({ open: false })
  });
  t.after(() => app.close());
  const ws = openClient(app);
  await once(ws, 'open');
  await expectClose(ws, 1008);
});

test('closes idle relay connections', async (t) => {
  const app = await start({ idleTimeoutMs: 15 });
  t.after(() => app.close());
  const ws = openClient(app);
  await once(ws, 'open');
  await expectClose(ws, 1008);
});

test('relays in both directions and constructs an approved upstream query', async (t) => {
  const app = await start();
  t.after(() => app.close());
  const ws = openClient(app, '/api/tts?ConnectionId=abc&Sec-MS-GEC=def&evil=%0d%0aHeader');
  await once(ws, 'open');

  const relayed = once(app.upstreams[0], 'sent');
  ws.send('client message');
  const [sent] = await relayed;
  assert.equal(sent.data.toString(), 'client message');

  const received = once(ws, 'message');
  app.upstreams[0].emit('message', Buffer.from('upstream message'), false);
  const [message] = await received;
  assert.equal(message.toString(), 'upstream message');

  const target = new URL(app.urls[0]);
  assert.equal(target.searchParams.get('ConnectionId'), 'abc');
  assert.equal(target.searchParams.get('Sec-MS-GEC'), 'def');
  assert.equal(target.searchParams.has('evil'), false);
  assert.equal(target.search.includes('?&'), false);
});

test('closes instead of buffering unbounded upstream traffic', async (t) => {
  const app = await start({
    maxBufferedBytes: 4,
    upstreamFactory() {
      const upstream = new FakeUpstream();
      upstream.bufferedAmount = 4;
      return upstream;
    }
  });
  t.after(() => app.close());
  const ws = openClient(app);
  await once(ws, 'open');
  ws.send('x');
  await expectClose(ws, 1009);
  assert.equal(app.activeClients, 0);
});
