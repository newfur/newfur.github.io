const CACHE_PREFIX = 'raconteur-pwa-';
const CACHE_VERSION = 'v3';
const PRECACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const RUNTIME_NAME = `${CACHE_PREFIX}runtime-${CACHE_VERSION}`;
const RUNTIME_MAX_ENTRIES = 50;
const RUNTIME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const keyMutations = new Map();
const requestGenerations = new Map();
let requestGeneration = 0;
let trimMutation = Promise.resolve();

// Use relative paths so the precache works under any subpath deployment.
// self.registration.scope gives us the base URL at runtime.
const REQUIRED_ASSETS_RELATIVE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon16.png',
  './icons/icon32.png',
  './icons/icon48.png',
  './icons/icon128.png',
  './icons/icon.svg'
];

self.addEventListener('install', (event) => {
  // Resolve relative asset paths against the service worker scope
  const scopeHref = (self.registration && self.registration.scope) || self.location.href.replace(/[^/]*$/, '');
  const resolved = REQUIRED_ASSETS_RELATIVE.map(rel => new URL(rel, scopeHref).href);
  event.waitUntil(
    caches.open(PRECACHE_NAME)
      .then((cache) => cache.addAll(resolved))
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
  if (url.origin !== self.location.origin || url.search || url.hash) return false;
  // Derive the scope base path so we work under any subpath deployment
  const scopeHref = (self.registration && self.registration.scope) || self.location.href.replace(/[^/]*$/, '');
  const scope = new URL(scopeHref);
  const scopePath = scope.pathname;
  if (!url.pathname.startsWith(scopePath)) return false;
  const relative = url.pathname.slice(scopePath.length);
  if (relative.startsWith('api/')) return false;
  if (request.destination === 'document' || request.mode === 'navigate') {
    return relative === '' || relative === 'index.html';
  }
  if (relative === 'manifest.webmanifest') return true;
  if (relative.startsWith('icons/')) return /\.(?:png|svg)$/i.test(relative);
  return false;
}

function isCacheable(response) {
  return Boolean(response) && response.status === 200 && response.type !== 'opaque' && response.type !== 'error';
}

function enqueueKey(key, mutation) {
  const name = typeof key === 'string' ? key : key.url;
  const previous = keyMutations.get(name) || Promise.resolve();
  const current = previous.catch(() => {}).then(mutation);
  keyMutations.set(name, current);
  return current.finally(() => {
    if (keyMutations.get(name) === current) keyMutations.delete(name);
  });
}

function nextGeneration(key) {
  const generation = ++requestGeneration;
  requestGenerations.set(key.url, generation);
  return generation;
}

function trimRuntimeCache(cache) {
  const run = async () => {
    const now = Date.now();
    const keys = await cache.keys();
    const dated = await Promise.all(keys.map(async (key) => {
      const cached = await enqueueKey(key, () => cache.match(key));
      return { key, storedAt: Number(cached?.headers.get('x-raconteur-cached-at')) || 0 };
    }));
    dated.sort((left, right) => left.storedAt - right.storedAt || left.key.url.localeCompare(right.key.url));
    const expired = dated.filter(({ storedAt }) => !storedAt || now - storedAt > RUNTIME_MAX_AGE_MS);
    const survivors = dated.filter(({ storedAt }) => storedAt && now - storedAt <= RUNTIME_MAX_AGE_MS);
    const excess = survivors.slice(0, Math.max(0, survivors.length - RUNTIME_MAX_ENTRIES));
    await Promise.all([...expired, ...excess].map(({ key, storedAt }) => enqueueKey(key, async () => {
      const current = await cache.match(key);
      const currentStoredAt = Number(current?.headers.get('x-raconteur-cached-at')) || 0;
      if (current && currentStoredAt === storedAt) await cache.delete(key);
    })));
  };
  trimMutation = trimMutation.catch(() => {}).then(run);
  return trimMutation;
}

async function storeRuntime(request, response, generation) {
  if (!isCacheable(response)) return;
  const headers = new Headers(response.headers);
  headers.set('x-raconteur-cached-at', String(Date.now()));
  const stored = new Response(await response.clone().arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
  const cache = await caches.open(RUNTIME_NAME);
  const key = cacheKey(request);
  const committed = await enqueueKey(key, async () => {
    if (requestGenerations.get(key.url) !== generation) return false;
    await cache.put(key, stored);
    return true;
  });
  if (!committed) return;
  await trimRuntimeCache(cache);
}

async function matchRuntime(cache, key) {
  return enqueueKey(key, async () => {
    const cached = await cache.match(key);
    if (!cached) return undefined;
    const storedAt = Number(cached.headers.get('x-raconteur-cached-at')) || 0;
    if (!storedAt || Date.now() - storedAt > RUNTIME_MAX_AGE_MS) {
      const current = await cache.match(key);
      const currentStoredAt = Number(current?.headers.get('x-raconteur-cached-at')) || 0;
      if (current && currentStoredAt === storedAt) await cache.delete(key);
      return undefined;
    }
    return cached;
  });
}

self.addEventListener('fetch', (event) => {
  if (!isApprovedRequest(event.request)) return;
  let resolveResponse;
  let rejectResponse;
  const responsePromise = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const key = cacheKey(event.request);
  const generation = nextGeneration(key);
  const lifetime = (async () => {
    const runtime = await caches.open(RUNTIME_NAME);
    const precache = await caches.open(PRECACHE_NAME);
    const cached = await matchRuntime(runtime, key) || await precache.match(key);
    if (cached) {
      resolveResponse(cached);
      await fetch(event.request).then((fresh) => storeRuntime(event.request, fresh, generation)).catch(() => {});
      return;
    }
    const network = await fetch(event.request);
    resolveResponse(network);
    await storeRuntime(event.request, network.clone(), generation);
  })().catch((error) => {
    rejectResponse(error);
    throw error;
  }).finally(() => {
    if (requestGenerations.get(key.url) === generation) requestGenerations.delete(key.url);
  });
  event.respondWith(responsePromise);
  event.waitUntil(lifetime);
});
