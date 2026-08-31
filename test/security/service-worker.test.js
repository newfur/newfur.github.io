import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '../..');

class EventTargetMock {
  listeners = new Map();

  addListener(listener) {
    this.listeners.set(listener, listener);
  }

  emit(...args) {
    for (const listener of this.listeners.values()) listener(...args);
  }
}

function response(body = '', init = {}) {
  return new Response(body, { status: 200, ...init });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadPwaWorker({ fetchImpl = async () => response('network'), addAll, cacheHooks = {} } = {}) {
  const listeners = {};
  const stores = new Map();
  const deleted = [];
  class CacheMock {
    entries = new Map();

    async addAll(urls) {
      if (addAll) return addAll(urls, this);
      for (const url of urls) this.entries.set(new URL(url, 'https://reader.example').href, response(url));
    }

    async match(request) {
      await cacheHooks.match?.(request, this);
      return this.entries.get(new URL(typeof request === 'string' ? request : request.url, 'https://reader.example').href);
    }

    async put(request, value) {
      await cacheHooks.put?.(request, value, this);
      this.entries.set(new URL(typeof request === 'string' ? request : request.url, 'https://reader.example').href, value);
    }

    async delete(request) {
      await cacheHooks.delete?.(request, this);
      return this.entries.delete(new URL(typeof request === 'string' ? request : request.url, 'https://reader.example').href);
    }

    async keys() {
      return [...this.entries.keys()].map((url) => new Request(url));
    }
  }
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new CacheMock());
      return stores.get(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      deleted.push(name);
      return stores.delete(name);
    },
    async match(request) {
      for (const cache of stores.values()) {
        const match = await cache.match(request);
        if (match) return match;
      }
    }
  };
  const self = {
    location: new URL('https://reader.example/sw.js'),
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener(type, listener) { listeners[type] = listener; }
  };
  const source = await readFile(path.join(ROOT, 'sw.js'), 'utf8');
  vm.runInNewContext(source, {
    self,
    caches,
    fetch: fetchImpl,
    URL,
    Request,
    Response,
    Headers,
    Promise,
    Date,
    console
  }, { filename: 'sw.js' });
  return { listeners, stores, deleted };
}

async function dispatchExtendable(listener, extra = {}) {
  const waits = [];
  listener({ ...extra, waitUntil(promise) { waits.push(Promise.resolve(promise)); } });
  await Promise.all(waits);
  return waits;
}

async function dispatchFetch(listener, request) {
  const waits = [];
  let responsePromise;
  listener({
    request,
    respondWith(promise) { responsePromise = Promise.resolve(promise); },
    waitUntil(promise) { waits.push(Promise.resolve(promise)); }
  });
  const result = responsePromise ? await responsePromise : undefined;
  await Promise.all(waits);
  return { response: result, waits };
}

async function loadExtensionWorker(fetchImpl) {
  const onMessage = new EventTargetMock();
  const onConnect = new EventTargetMock();
  const chrome = {
    action: { onClicked: new EventTargetMock() },
    tabs: { create() {} },
    runtime: {
      id: 'extension-id',
      getURL: (value) => `chrome-extension://extension-id/${value}`,
      onInstalled: new EventTargetMock(),
      onStartup: new EventTargetMock(),
      onMessage,
      onConnect,
      lastError: null
    },
    declarativeNetRequest: {
      updateDynamicRules(_rules, callback) { callback(); }
    }
  };
  const source = await readFile(path.join(ROOT, 'service-worker.js'), 'utf8');
  vm.runInNewContext(source, {
    chrome,
    fetch: fetchImpl,
    URL,
    AbortController,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    console
  }, { filename: 'service-worker.js' });
  return chrome;
}

function validSender(overrides = {}) {
  return {
    id: 'extension-id',
    url: 'chrome-extension://extension-id/reader/reader.html',
    ...overrides
  };
}

async function sendMessage(chrome, request, sender = validSender()) {
  return new Promise((resolve) => {
    const listener = [...chrome.runtime.onMessage.listeners.values()][0];
    const keepAlive = listener(request, sender, resolve);
    if (keepAlive !== true) resolve(undefined);
  });
}

function createPort(sender = validSender()) {
  return {
    name: 'ai-stream',
    sender,
    messages: [],
    onMessage: new EventTargetMock(),
    onDisconnect: new EventTargetMock(),
    postMessage(message) { this.messages.push(message); }
  };
}

async function waitFor(predicate, timeout = 250) {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('deployment header policies are present and aligned for Node and Vercel', async () => {
  const server = await readFile(path.join(ROOT, 'server.js'), 'utf8');
  const vercel = JSON.parse(await readFile(path.join(ROOT, 'vercel.json'), 'utf8'));
  const values = Object.fromEntries(vercel.headers[0].headers.map(({ key, value }) => [key.toLowerCase(), value]));
  for (const name of ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options', 'permissions-policy']) {
    assert.ok(values[name], `${name} missing from Vercel`);
    assert.match(server.toLowerCase(), new RegExp(name), `${name} missing from Node server`);
  }
  assert.match(values['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(values['content-security-policy'], /connect-src[^;]*(?:https:|wss:)/);
  assert.equal(values['x-content-type-options'], 'nosniff');
  assert.equal(values['x-frame-options'], 'DENY');
});

test('PWA install rejects when a required precache asset fails', async () => {
  const worker = await loadPwaWorker({ addAll: async () => { throw new Error('missing'); } });
  await assert.rejects(dispatchExtendable(worker.listeners.install), /missing/);
});

test('PWA activation deletes only stale application caches', async () => {
  const worker = await loadPwaWorker();
  await worker.stores.set('unrelated-cache', {});
  await worker.stores.set('raconteur-pwa-v1', {});
  await worker.stores.set('raconteur-pwa-v3', {});
  await dispatchExtendable(worker.listeners.activate);
  assert.deepEqual(worker.deleted, ['raconteur-pwa-v1']);
  assert.ok(worker.stores.has('unrelated-cache'));
  assert.ok(worker.stores.has('raconteur-pwa-v3'));
});

test('PWA fetch handles approved same-origin GET routes and attaches writes to waitUntil', async () => {
  const worker = await loadPwaWorker({ fetchImpl: async () => response('fresh') });
  await dispatchExtendable(worker.listeners.install);
  const result = await dispatchFetch(worker.listeners.fetch, new Request('https://reader.example/icons/icon16.png'));
  assert.equal(await result.response.text(), 'https://reader.example/icons/icon16.png');
  assert.equal(result.waits.length, 1);
});

test('PWA fetch registers its lifetime promise synchronously', async () => {
  const worker = await loadPwaWorker({ fetchImpl: async () => response('fresh') });
  const waits = [];
  worker.listeners.fetch({
    request: new Request('https://reader.example/icons/new.png'),
    respondWith() {},
    waitUntil(promise) { waits.push(promise); }
  });
  assert.equal(waits.length, 1);
  await Promise.all(waits);
});

test('PWA fetch serves a refreshed runtime entry instead of the older precache copy', async () => {
  const worker = await loadPwaWorker({ fetchImpl: async () => response('fresh') });
  await dispatchExtendable(worker.listeners.install);
  await dispatchFetch(worker.listeners.fetch, new Request('https://reader.example/icons/icon16.png'));
  const second = await dispatchFetch(worker.listeners.fetch, new Request('https://reader.example/icons/icon16.png'));
  assert.equal(await second.response.text(), 'fresh');
});

test('PWA fetch ignores matching responses in unrelated origin caches', async () => {
  let fetches = 0;
  const worker = await loadPwaWorker({
    fetchImpl: async () => {
      fetches += 1;
      return response('network');
    }
  });
  worker.stores.set('unrelated-cache', {
    async match(request) {
      return request.url === 'https://reader.example/icons/shared.png' ? response('unrelated') : undefined;
    }
  });

  const result = await dispatchFetch(worker.listeners.fetch, new Request('https://reader.example/icons/shared.png'));

  assert.equal(await result.response.text(), 'network');
  assert.equal(fetches, 1);
});

test('PWA fetch excludes API, cross-origin, query variants, downloads, and non-GET requests', async () => {
  const worker = await loadPwaWorker();
  const requests = [
    new Request('https://reader.example/api/voices'),
    new Request('https://other.example/icons/icon16.png'),
    new Request('https://reader.example/icons/icon16.png?variant=1'),
    new Request('https://reader.example/export.epub'),
    new Request('https://reader.example/index.html', { method: 'POST' })
  ];
  for (const request of requests) {
    const result = await dispatchFetch(worker.listeners.fetch, request);
    assert.equal(result.response, undefined, request.url);
    assert.equal(result.waits.length, 0, request.url);
  }
});

test('PWA runtime cache rejects opaque and error responses and evicts deterministically', async () => {
  let count = 0;
  const worker = await loadPwaWorker({ fetchImpl: async () => response(`asset-${count++}`) });
  for (let index = 0; index < 65; index += 1) {
    await dispatchFetch(worker.listeners.fetch, new Request(`https://reader.example/icons/runtime-${String(index).padStart(2, '0')}.png`));
  }
  const runtime = worker.stores.get('raconteur-pwa-runtime-v3');
  assert.ok(runtime.entries.size <= 50);
  assert.equal(runtime.entries.has('https://reader.example/icons/runtime-00.png'), false);
  assert.equal(runtime.entries.has('https://reader.example/icons/runtime-64.png'), true);
});

test('PWA runtime cache does not store non-200 responses', async () => {
  const worker = await loadPwaWorker({ fetchImpl: async () => response('missing', { status: 404 }) });
  const result = await dispatchFetch(worker.listeners.fetch, new Request('https://reader.example/icons/missing.png'));
  assert.equal(result.response.status, 404);
  assert.equal(worker.stores.get('raconteur-pwa-runtime-v3').entries.size, 0);
});

test('PWA fetch discards an expired runtime entry before responding', async () => {
  const worker = await loadPwaWorker({ fetchImpl: async () => response('network') });
  const runtime = new (class {
    entries = new Map([['https://reader.example/icons/old.png', response('stale', {
      headers: { 'x-raconteur-cached-at': String(Date.now() - 8 * 24 * 60 * 60 * 1000) }
    })]]);
    async match(request) { return this.entries.get(request.url); }
    async delete(request) { return this.entries.delete(request.url); }
    async put(request, value) { this.entries.set(request.url, value); }
    async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
  })();
  worker.stores.set('raconteur-pwa-runtime-v3', runtime);
  const result = await dispatchFetch(worker.listeners.fetch, new Request('https://reader.example/icons/old.png'));
  assert.equal(await result.response.text(), 'network');
  assert.equal(await runtime.entries.get('https://reader.example/icons/old.png').text(), 'network');
});

test('PWA runtime cache keeps the newest same-key request when fetches finish out of order', async () => {
  const first = deferred();
  const second = deferred();
  let fetches = 0;
  const worker = await loadPwaWorker({
    fetchImpl: () => (fetches++ === 0 ? first.promise : second.promise)
  });
  const request = new Request('https://reader.example/icons/race.png');
  const older = dispatchFetch(worker.listeners.fetch, request);
  const newer = dispatchFetch(worker.listeners.fetch, request);
  await waitFor(() => fetches === 2);
  second.resolve(response('newer'));
  await newer;
  first.resolve(response('older'));
  await older;

  const cached = worker.stores.get('raconteur-pwa-runtime-v3').entries.get(request.url);
  assert.equal(await cached.text(), 'newer');
});

test('PWA expiry deletion cannot remove a same-key replacement', async () => {
  const deleting = deferred();
  const releaseDelete = deferred();
  let held = false;
  const worker = await loadPwaWorker({ fetchImpl: async () => response('replacement') });
  const runtime = new (class {
    entries = new Map([['https://reader.example/icons/expiry-race.png', response('expired', {
      headers: { 'x-raconteur-cached-at': String(Date.now() - 8 * 24 * 60 * 60 * 1000) }
    })]]);
    async match(request) { return this.entries.get(request.url); }
    async delete(request) {
      if (!held) {
        held = true;
        deleting.resolve();
        await releaseDelete.promise;
      }
      return this.entries.delete(request.url);
    }
    async put(request, value) { this.entries.set(request.url, value); }
    async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
  })();
  worker.stores.set('raconteur-pwa-runtime-v3', runtime);
  const request = new Request('https://reader.example/icons/expiry-race.png');
  const first = dispatchFetch(worker.listeners.fetch, request);
  await deleting.promise;
  const replacement = dispatchFetch(worker.listeners.fetch, request);
  releaseDelete.resolve();
  await Promise.all([first, replacement]);
  assert.equal(await runtime.entries.get(request.url).text(), 'replacement');
});

test('PWA trim snapshot cannot delete an entry refreshed before mutation', async () => {
  const scanning = deferred();
  const releaseScan = deferred();
  let pauseScan = false;
  let paused = false;
  const worker = await loadPwaWorker({
    fetchImpl: async (request) => response(request.url.endsWith('/trim-race.png') ? 'refreshed' : 'network'),
    cacheHooks: {
      async match(request) {
        if (pauseScan && !paused && request.url.endsWith('/zz-blocker.png')) {
          paused = true;
          scanning.resolve();
          await releaseScan.promise;
        }
      }
    }
  });
  await dispatchFetch(worker.listeners.fetch, new Request('https://reader.example/icons/seed.png'));
  const runtime = worker.stores.get('raconteur-pwa-runtime-v3');
  const now = Date.now();
  runtime.entries.clear();
  runtime.entries.set('https://reader.example/icons/trim-race.png', response('old', {
    headers: { 'x-raconteur-cached-at': String(now - 1000) }
  }));
  for (let index = 0; index < 49; index += 1) {
    const name = index === 48 ? 'zz-blocker' : `entry-${String(index).padStart(2, '0')}`;
    runtime.entries.set(`https://reader.example/icons/${name}.png`, response(name, {
      headers: { 'x-raconteur-cached-at': String(now) }
    }));
  }
  pauseScan = true;
  const overflow = dispatchFetch(worker.listeners.fetch, new Request('https://reader.example/icons/overflow.png'));
  await scanning.promise;
  const refresh = dispatchFetch(worker.listeners.fetch, new Request('https://reader.example/icons/trim-race.png'));
  await waitFor(async () => {
    const value = runtime.entries.get('https://reader.example/icons/trim-race.png');
    return value && await value.clone().text() === 'refreshed';
  });
  releaseScan.resolve();
  await Promise.all([overflow, refresh]);
  assert.equal(await runtime.entries.get('https://reader.example/icons/trim-race.png').text(), 'refreshed');
});

test('extension proxy rejects foreign senders, caller URLs, providers, credentials, and private targets', async () => {
  let fetches = 0;
  const chrome = await loadExtensionWorker(async () => { fetches += 1; return response('{}'); });
  const cases = [
    [{ action: 'fetchModels', provider: 'openai', url: 'https://api.openai.com/v1' }, validSender({ id: 'other' })],
    [{ action: 'fetchModels', provider: 'openai', url: 'https://api.openai.com/v1' }, validSender({ url: 'https://evil.example/' })],
    [{ action: 'fetchModels', provider: 'unknown', url: 'https://api.openai.com/v1' }, validSender()],
    [{ action: 'fetchModels', provider: 'openai', url: 'https://user:pass@example.com/v1' }, validSender()],
    [{ action: 'fetchModels', provider: 'openai', url: 'http://192.168.1.2:1234/v1' }, validSender()],
    [{ action: 'fetchModels', provider: 'openai', url: 'http://localhost:9999/v1' }, validSender()]
  ];
  for (const [request, sender] of cases) {
    const result = await sendMessage(chrome, request, sender);
    assert.equal(result?.success, false);
  }
  assert.equal(fetches, 0);
});

test('extension proxy rejects oversized request fields before fetching', async () => {
  let fetches = 0;
  const chrome = await loadExtensionWorker(async () => { fetches += 1; return response('{}'); });
  const result = await sendMessage(chrome, {
    action: 'fetchModels',
    provider: 'openai',
    url: `https://api.openai.com/${'x'.repeat(3000)}`,
    apiKey: 'k'.repeat(9000)
  });
  assert.equal(result.success, false);
  assert.equal(fetches, 0);
});

test('extension proxy permits cloud OpenAI-compatible, Ollama, and advertised LM Studio endpoints', async () => {
  const urls = [];
  const chrome = await loadExtensionWorker(async (url) => {
    urls.push(String(url));
    return response(JSON.stringify({ data: [{ id: 'model' }], models: [{ name: 'local' }] }), {
      headers: { 'Content-Type': 'application/json' }
    });
  });
  assert.equal((await sendMessage(chrome, { action: 'fetchModels', provider: 'openai', url: 'https://api.deepseek.com' })).success, true);
  assert.equal((await sendMessage(chrome, { action: 'fetchModels', provider: 'ollama', url: 'http://localhost:11434' })).success, true);
  assert.equal((await sendMessage(chrome, { action: 'fetchModels', provider: 'openai', url: 'http://localhost:1234/v1' })).success, true);
  assert.deepEqual(urls, [
    'https://api.deepseek.com/models',
    'http://localhost:11434/api/tags',
    'http://localhost:1234/v1/models'
  ]);
});

test('extension proxy normalizes equivalent loopback hosts and rejects unspecified or private IPv6', async () => {
  const urls = [];
  const chrome = await loadExtensionWorker(async (url) => {
    urls.push(String(url));
    return response(JSON.stringify({ models: [{ name: 'local' }], data: [{ id: 'local' }] }));
  });
  const allowed = [
    'http://localhost.:11434',
    'http://[::1]:11434',
    'http://[::ffff:127.0.0.1]:11434',
    'http://[::ffff:7f00:1]:11434'
  ];
  for (const url of allowed) {
    const result = await sendMessage(chrome, { action: 'fetchModels', provider: 'ollama', url });
    assert.equal(result.success, true, url);
  }
  const rejected = [
    'http://[::]:11434',
    'http://[fe80::1]:11434',
    'http://[fc00::1]:11434',
    'http://[fd00::1]:11434',
    'http://api.localhost:11434',
    'http://localhost',
    'http://localhost:11434/unrecognized'
  ];
  for (const url of rejected) {
    const result = await sendMessage(chrome, { action: 'fetchModels', provider: 'ollama', url });
    assert.equal(result.success, false, url);
  }
  assert.equal(urls.length, allowed.length);
});

test('extension proxy applies loopback equivalence to LM Studio and classifies mapped IPv4 ranges', async () => {
  const urls = [];
  const chrome = await loadExtensionWorker(async (url) => {
    urls.push(String(url));
    return response(JSON.stringify({ data: [{ id: 'model' }] }));
  });
  for (const url of [
    'http://localhost.:1234/v1',
    'http://[::1]:1234/v1',
    'http://[::ffff:127.0.0.1]:1234/v1',
    'http://[::ffff:7f00:1]:1234/v1'
  ]) {
    assert.equal((await sendMessage(chrome, { action: 'fetchModels', provider: 'openai', url })).success, true, url);
  }
  assert.equal((await sendMessage(chrome, {
    action: 'fetchModels', provider: 'openai', url: 'http://[::ffff:c0a8:101]:1234/v1'
  })).success, false);
  assert.equal((await sendMessage(chrome, {
    action: 'fetchModels', provider: 'openai', url: 'http://[::ffff:808:808]:8080/v1'
  })).success, true);
  assert.equal(urls.length, 5);
});

test('extension Ollama model lookup falls back to its OpenAI-compatible endpoint', async () => {
  const urls = [];
  const chrome = await loadExtensionWorker(async (url) => {
    urls.push(String(url));
    if (String(url).endsWith('/api/tags')) return response('missing', { status: 404 });
    return response(JSON.stringify({ data: [{ id: 'fallback-model' }] }));
  });
  const result = await sendMessage(chrome, { action: 'fetchModels', provider: 'ollama', url: 'http://localhost:11434' });
  assert.equal(result.success, true);
  assert.deepEqual([...result.models], ['fallback-model']);
  assert.deepEqual(urls, ['http://localhost:11434/api/tags', 'http://localhost:11434/v1/models']);
});

test('extension Ollama fallback recovers after the primary body times out', async () => {
  const urls = [];
  const chrome = await loadExtensionWorker(async (url, options) => {
    urls.push(String(url));
    if (urls.length === 1) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          getReader() {
            return { read: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('stalled')))) };
          }
        }
      };
    }
    return response(JSON.stringify({ data: [{ id: 'fallback' }] }));
  });
  const result = await sendMessage(chrome, {
    action: 'fetchModels', provider: 'ollama', url: 'http://localhost:11434/api/chat/', timeoutMs: 5
  });
  assert.equal(result.success, true);
  assert.deepEqual([...result.models], ['fallback']);
  assert.deepEqual(urls, ['http://localhost:11434/api/tags', 'http://localhost:11434/v1/models']);
});

test('extension stream replaces known endpoint suffixes without duplication', async () => {
  const urls = [];
  const chrome = await loadExtensionWorker(async (url) => {
    urls.push(String(url));
    return response('');
  });
  for (const [provider, url] of [
    ['ollama', 'http://localhost:11434/v1/models/'],
    ['openai', 'http://localhost:1234/v1/models/']
  ]) {
    const port = createPort();
    chrome.runtime.onConnect.emit(port);
    port.onMessage.emit({ action: 'chat', provider, url, model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    await waitFor(() => port.messages.some(({ type }) => type === 'done'));
  }
  assert.deepEqual(urls, [
    'http://localhost:11434/api/chat',
    'http://localhost:1234/v1/chat/completions'
  ]);
});

test('extension Ollama fallback handles malformed JSON and normalizes known suffixes', async () => {
  const urls = [];
  const chrome = await loadExtensionWorker(async (url) => {
    urls.push(String(url));
    if (urls.length === 1) return response('{malformed');
    return response(JSON.stringify({ data: [{ id: 'fallback' }] }));
  });
  const result = await sendMessage(chrome, {
    action: 'fetchModels',
    provider: 'ollama',
    url: 'http://localhost:11434/api/tags/'
  });
  assert.equal(result.success, true);
  assert.deepEqual([...result.models], ['fallback']);
  assert.deepEqual(urls, ['http://localhost:11434/api/tags', 'http://localhost:11434/v1/models']);
});

test('extension model timeout remains active through a stalled response body', async () => {
  let signal;
  const chrome = await loadExtensionWorker(async (_url, options) => {
    signal = options.signal;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader() {
          return { read: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('stalled')))) };
        }
      }
    };
  });
  const result = await sendMessage(chrome, {
    action: 'fetchModels', provider: 'openai', url: 'https://api.openai.com/v1', timeoutMs: 5
  });
  assert.equal(result.success, false);
  assert.equal(signal.aborted, true);
});

test('extension model response aborts when its body exceeds the configured cap', async () => {
  let signal;
  const chunk = new Uint8Array(1024 * 1024);
  const chrome = await loadExtensionWorker(async (_url, options) => {
    signal = options.signal;
    let reads = 0;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader() {
          return { async read() { return reads++ < 5 ? { done: false, value: chunk } : { done: true }; } };
        }
      }
    };
  });
  const result = await sendMessage(chrome, {
    action: 'fetchModels', provider: 'openai', url: 'https://api.openai.com/v1'
  });
  assert.equal(result.success, false);
  assert.equal(signal.aborted, true);
});

test('fetchVoices ignores arbitrary request URLs and uses only the fixed endpoint', async () => {
  const urls = [];
  const chrome = await loadExtensionWorker(async (url) => {
    urls.push(String(url));
    return response('[]', { headers: { 'Content-Type': 'application/json' } });
  });
  const result = await sendMessage(chrome, { action: 'fetchVoices', url: 'https://evil.example/steal' });
  assert.equal(result.success, true);
  assert.equal(new URL(urls[0]).hostname, 'speech.platform.bing.com');
});

test('extension stream caps messages and body size before fetching', async () => {
  let fetches = 0;
  const chrome = await loadExtensionWorker(async () => { fetches += 1; return response(''); });
  const port = createPort();
  chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({
    action: 'chat',
    provider: 'openai',
    url: 'https://api.openai.com/v1',
    model: 'model',
    messages: Array.from({ length: 101 }, () => ({ role: 'user', content: 'x'.repeat(10000) }))
  });
  await waitFor(() => port.messages.length > 0);
  assert.equal(port.messages[0].type, 'error');
  assert.equal(fetches, 0);
});

test('extension port ignores concurrent chat messages before starting another fetch', async () => {
  let fetches = 0;
  const chrome = await loadExtensionWorker((_url, options) => {
    fetches += 1;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  const port = createPort();
  chrome.runtime.onConnect.emit(port);
  const message = { action: 'chat', provider: 'openai', url: 'https://api.openai.com/v1', model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  port.onMessage.emit(message);
  await waitFor(() => fetches === 1);
  port.onMessage.emit(message);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fetches, 1);
  port.onDisconnect.emit();
});

test('extension stream timeout aborts fetch and settles once without leaking upstream errors', async () => {
  let signal;
  const chrome = await loadExtensionWorker((_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('secret upstream body'))));
  });
  const port = createPort();
  chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({ action: 'chat', provider: 'openai', url: 'https://api.openai.com/v1', model: 'm', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 5 });
  await waitFor(() => port.messages.length > 0, 500);
  assert.equal(signal.aborted, true);
  assert.deepEqual(port.messages.map(({ type }) => type), ['error']);
  assert.doesNotMatch(port.messages[0].message, /secret|api[_ -]?key/i);
});

test('extension stream timeout remains active after response headers arrive', async () => {
  let signal;
  const chrome = await loadExtensionWorker(async (_url, options) => {
    signal = options.signal;
    return {
      ok: true,
      body: {
        getReader() {
          return { read: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('body stalled')))) };
        }
      }
    };
  });
  const port = createPort();
  chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({ action: 'chat', provider: 'openai', url: 'https://api.openai.com/v1', model: 'm', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 5 });
  await waitFor(() => port.messages.length > 0, 500);
  assert.equal(signal.aborted, true);
  assert.deepEqual(port.messages.map(({ type }) => type), ['error']);
});

test('extension stream disconnect aborts its active request without posting a terminal message', async () => {
  let signal;
  const chrome = await loadExtensionWorker((_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  const port = createPort();
  chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({ action: 'chat', provider: 'ollama', url: 'http://localhost:11434', model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  await waitFor(() => signal);
  port.onDisconnect.emit();
  await waitFor(() => signal.aborted);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(port.messages, []);
});
