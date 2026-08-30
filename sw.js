const CACHE_PREFIX = 'raconteur-pwa-';
const CACHE_VERSION = 'v3';
const PRECACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const RUNTIME_NAME = `${CACHE_PREFIX}runtime-${CACHE_VERSION}`;
const RUNTIME_MAX_ENTRIES = 50;
const RUNTIME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REQUIRED_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon16.png',
  '/icons/icon32.png',
  '/icons/icon48.png',
  '/icons/icon128.png',
  '/icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PRECACHE_NAME)
      .then((cache) => cache.addAll(REQUIRED_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== PRECACHE_NAME && name !== RUNTIME_NAME)
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

function cacheKey(request) {
  const url = new URL(request.url);
  return new Request(url.origin + url.pathname, { method: 'GET' });
}

function isApprovedRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search || url.hash || url.pathname.startsWith('/api/')) return false;
  if (request.destination === 'document' || request.mode === 'navigate') {
    return url.pathname === '/' || url.pathname === '/index.html';
  }
  if (url.pathname === '/manifest.webmanifest') return true;
  if (url.pathname.startsWith('/icons/')) return /\.(?:png|svg)$/i.test(url.pathname);
  return false;
}

function isCacheable(response) {
  return Boolean(response) && response.status === 200 && response.type !== 'opaque' && response.type !== 'error';
}

async function trimRuntimeCache(cache) {
  const now = Date.now();
  const keys = await cache.keys();
  const dated = await Promise.all(keys.map(async (key) => {
    const cached = await cache.match(key);
    const storedAt = Number(cached?.headers.get('x-raconteur-cached-at')) || 0;
    return { key, storedAt };
  }));
  dated.sort((left, right) => left.storedAt - right.storedAt || left.key.url.localeCompare(right.key.url));
  const expired = dated.filter(({ storedAt }) => !storedAt || now - storedAt > RUNTIME_MAX_AGE_MS);
  const survivors = dated.filter(({ storedAt }) => storedAt && now - storedAt <= RUNTIME_MAX_AGE_MS);
  const excess = survivors.slice(0, Math.max(0, survivors.length - RUNTIME_MAX_ENTRIES));
  await Promise.all([...expired, ...excess].map(({ key }) => cache.delete(key)));
}

async function storeRuntime(request, response) {
  if (!isCacheable(response)) return;
  const headers = new Headers(response.headers);
  headers.set('x-raconteur-cached-at', String(Date.now()));
  const stored = new Response(await response.clone().arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
  const cache = await caches.open(RUNTIME_NAME);
  await cache.put(cacheKey(request), stored);
  await trimRuntimeCache(cache);
}

async function matchRuntime(cache, key) {
  const cached = await cache.match(key);
  if (!cached) return undefined;
  const storedAt = Number(cached.headers.get('x-raconteur-cached-at')) || 0;
  if (!storedAt || Date.now() - storedAt > RUNTIME_MAX_AGE_MS) {
    await cache.delete(key);
    return undefined;
  }
  return cached;
}

self.addEventListener('fetch', (event) => {
  if (!isApprovedRequest(event.request)) return;
  let resolveResponse;
  let rejectResponse;
  const responsePromise = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const lifetime = (async () => {
    const key = cacheKey(event.request);
    const runtime = await caches.open(RUNTIME_NAME);
    const precache = await caches.open(PRECACHE_NAME);
    const cached = await matchRuntime(runtime, key) || await precache.match(key);
    if (cached) {
      resolveResponse(cached);
      await fetch(event.request).then((fresh) => storeRuntime(event.request, fresh)).catch(() => {});
      return;
    }
    const network = await fetch(event.request);
    resolveResponse(network);
    await storeRuntime(event.request, network.clone());
  })().catch((error) => {
    rejectResponse(error);
    throw error;
  });
  event.respondWith(responsePromise);
  event.waitUntil(lifetime);
});
