import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BoundedResourceCache,
  OwnedResourceSlot,
  ResourceOwnership,
  cleanupOwnedResourceLists,
} from '../../reader/resource-ownership.js';
import { TTSEngine } from '../../reader/tts.js';
import { ComicParser } from '../../reader/parsers/comic-parser.js';

function createFakeUrlApi() {
  let nextId = 0;
  const revoked = [];
  return {
    revoked,
    createObjectURL() {
      return `blob:https://reader.test/${++nextId}`;
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };
}

function createBareTts(resources) {
  const engine = Object.create(TTSEngine.prototype);
  Object.assign(engine, {
    resourceOwnership: resources,
    playbackGeneration: 1,
    ownerBookId: 'book-a',
    activeRequests: new Set(),
    retryTimers: new Set(),
    fetchingIndices: new Map(),
    audioCache: new Map(),
    sentences: [{ text: 'one' }, { text: 'two' }],
    selectedVoice: { name: 'voice', type: 'openai' },
    voices: [{ name: 'voice', type: 'openai' }, { name: 'other', type: 'openai' }],
    ttsProvider: 'openai',
    isPlaying: false,
    isPaused: false,
    playbackStarted: false,
    currentIndex: 0,
    currentlyPlayingIndex: -1,
    nativeQueue: new Set(),
    players: [],
    synth: null,
    prefetchedChapterIndex: null,
  });
  return engine;
}

test('owner registry releases each blob URL exactly once', () => {
  const urlApi = createFakeUrlApi();
  const resources = new ResourceOwnership(urlApi);
  const url = urlApi.createObjectURL(new Blob(['chapter']));

  resources.register('chapter', url);
  resources.register('chapter', url);
  assert.equal(resources.has('chapter', url), true);

  assert.equal(resources.release('chapter', url), true);
  assert.equal(resources.release('chapter', url), false);
  resources.revokeOwner('chapter');
  assert.deepEqual(urlApi.revoked, [url]);
});

test('shared URL remains alive until its final owner is released', () => {
  const urlApi = createFakeUrlApi();
  const resources = new ResourceOwnership(urlApi);
  const url = urlApi.createObjectURL(new Blob(['shared']));

  resources.register('owner-a', url);
  resources.register('owner-b', url);
  resources.release('owner-a', url);
  assert.deepEqual(urlApi.revoked, []);

  resources.release('owner-b', url);
  resources.release('owner-b', url);
  assert.deepEqual(urlApi.revoked, [url]);
});

test('owner-scoped parser cleanup cannot revoke another owner shared URL', () => {
  const urlApi = createFakeUrlApi();
  const finalized = [];
  const resources = new ResourceOwnership(urlApi, url => finalized.push(url));
  const url = urlApi.createObjectURL(new Blob(['shared parser resource']));
  const parserOwner = { type: 'parser' };
  const mountedOwner = { type: 'chapter' };

  resources.register(parserOwner, url);
  resources.register(mountedOwner, url);
  const parserResult = { resourceUrls: [url] };
  const parser = { resourceUrls: [url] };
  cleanupOwnedResourceLists(resources, parserOwner, parserResult.resourceUrls, parser.resourceUrls);

  assert.equal(resources.has(mountedOwner, url), true);
  assert.deepEqual(parserResult.resourceUrls, []);
  assert.deepEqual(parser.resourceUrls, []);
  assert.deepEqual(urlApi.revoked, []);
  assert.deepEqual(finalized, []);

  resources.release(mountedOwner, url);
  assert.deepEqual(urlApi.revoked, [url]);
  assert.deepEqual(finalized, [url]);
});

test('duplicate finalizers run once and non-blob URLs are ignored', () => {
  const urlApi = createFakeUrlApi();
  const finalized = [];
  const resources = new ResourceOwnership(urlApi, url => finalized.push(url));
  const blobUrl = urlApi.createObjectURL(new Blob(['trusted']));

  resources.register('book', blobUrl);
  resources.register('book', blobUrl);
  resources.register('book', 'data:image/png;base64,AA==');
  resources.register('book', 'https://cdn.example/cover.jpg');
  resources.revokeOwner('book');
  resources.revokeAll();

  assert.deepEqual(urlApi.revoked, [blobUrl]);
  assert.deepEqual(finalized, [blobUrl]);
});

test('request resources can transfer to a book and stale requests clean up immediately', () => {
  const urlApi = createFakeUrlApi();
  const resources = new ResourceOwnership(urlApi);
  const accepted = urlApi.createObjectURL(new Blob(['accepted']));
  const stale = urlApi.createObjectURL(new Blob(['stale']));

  resources.register('open:1', accepted);
  assert.equal(resources.transfer('open:1', 'book:a', accepted), true);
  resources.revokeOwner('open:1');
  assert.deepEqual(urlApi.revoked, []);

  resources.register('open:2', stale);
  resources.revokeOwner('open:2');
  assert.deepEqual(urlApi.revoked, [stale]);

  resources.revokeOwner('book:a');
  assert.deepEqual(urlApi.revoked, [stale, accepted]);
});

test('chapter replacement revokes old resources only after DOM replacement', () => {
  const urlApi = createFakeUrlApi();
  const resources = new ResourceOwnership(urlApi);
  const slot = new OwnedResourceSlot(resources);
  const oldUrl = urlApi.createObjectURL(new Blob(['old chapter']));
  const newUrl = urlApi.createObjectURL(new Blob(['new chapter']));
  const events = [];

  resources.register('chapter:old', oldUrl);
  resources.register('chapter:new', newUrl);
  slot.replace('chapter:old', () => events.push('old mounted'));
  slot.replace('chapter:new', () => {
    events.push('new mounted');
    assert.deepEqual(urlApi.revoked, []);
  });

  assert.deepEqual(events, ['old mounted', 'new mounted']);
  assert.deepEqual(urlApi.revoked, [oldUrl]);
});

test('comic page replacement and stale page completion revoke safely', () => {
  const urlApi = createFakeUrlApi();
  const resources = new ResourceOwnership(urlApi);
  const slot = new OwnedResourceSlot(resources);
  const first = urlApi.createObjectURL(new Blob(['page one']));
  const second = urlApi.createObjectURL(new Blob(['page two']));
  const stale = urlApi.createObjectURL(new Blob(['stale page']));

  resources.register('comic:1', first);
  slot.replace('comic:1', () => {});
  resources.register('comic:2', second);
  slot.replace('comic:2', () => assert.deepEqual(urlApi.revoked, []));
  resources.register('comic:stale', stale);
  resources.revokeOwner('comic:stale');

  assert.deepEqual(urlApi.revoked, [first, stale]);
});

test('close-book cleanup releases chapter, comic, parser, and prefetch owners', () => {
  const urlApi = createFakeUrlApi();
  const resources = new ResourceOwnership(urlApi);
  const urls = ['chapter', 'comic', 'parser', 'prefetch'].map(name => {
    const url = urlApi.createObjectURL(new Blob([name]));
    resources.register(`book:a:${name}`, url);
    return url;
  });

  resources.revokeMatching(owner => String(owner).startsWith('book:a:'));

  assert.deepEqual(new Set(urlApi.revoked), new Set(urls));
});

test('bounded cache evicts oldest owner and replacement releases its prior owner', () => {
  const urlApi = createFakeUrlApi();
  const resources = new ResourceOwnership(urlApi);
  const cache = new BoundedResourceCache(2, resources);
  const first = urlApi.createObjectURL(new Blob(['one']));
  const second = urlApi.createObjectURL(new Blob(['two']));
  const third = urlApi.createObjectURL(new Blob(['three']));
  const replacement = urlApi.createObjectURL(new Blob(['replacement']));

  resources.register('prefetch:1', first);
  resources.register('prefetch:2', second);
  resources.register('prefetch:3', third);
  resources.register('prefetch:2b', replacement);
  cache.set(1, { owner: 'prefetch:1', html: 'one' });
  cache.set(2, { owner: 'prefetch:2', html: 'two' });
  cache.set(3, { owner: 'prefetch:3', html: 'three' });
  cache.set(2, { owner: 'prefetch:2b', html: 'replacement' });

  assert.deepEqual(urlApi.revoked, [first, second]);
  assert.deepEqual([...cache.keys()], [3, 2]);
});

test('TTS group references release their shared object URL once', () => {
  const urlApi = createFakeUrlApi();
  const resources = new ResourceOwnership(urlApi);
  const engine = createBareTts(resources);
  const url = urlApi.createObjectURL(new Blob(['group']));

  engine._storeGroupCache(10, [{ text: 'a' }, { text: 'b' }, { text: 'c' }], url);
  engine._deleteAudioCacheEntry(11);
  engine._deleteAudioCacheEntry(10);
  engine._deleteAudioCacheEntry(12);

  assert.deepEqual(urlApi.revoked, [url]);
});

test('TTS group replacement releases the old root without leaking or overwriting newer sessions', () => {
  const urlApi = createFakeUrlApi();
  const resources = new ResourceOwnership(urlApi);
  const engine = createBareTts(resources);
  const oldUrl = urlApi.createObjectURL(new Blob(['old group']));
  const replacementUrl = urlApi.createObjectURL(new Blob(['replacement group']));
  const staleUrl = urlApi.createObjectURL(new Blob(['stale group']));

  engine._storeGroupCache(10, [{ text: 'old a' }, { text: 'old b' }], oldUrl, 1, 'book-a');
  engine._storeGroupCache(10, [{ text: 'new a' }], replacementUrl, 1, 'book-a');

  assert.deepEqual(urlApi.revoked, [oldUrl]);
  assert.equal(engine.audioCache.get(10).blobUrl, replacementUrl);
  assert.equal(engine.audioCache.has(11), false);

  engine._storeGroupCache(10, [{ text: 'stale' }], staleUrl, 0, 'book-a');
  assert.equal(engine.audioCache.get(10).blobUrl, replacementUrl);
  assert.deepEqual(urlApi.revoked, [oldUrl, staleUrl]);
  engine._deleteAudioCacheEntry(10);
  assert.deepEqual(urlApi.revoked, [oldUrl, staleUrl, replacementUrl]);
});

test('stale TTS group completion cannot revoke the active session URL at the same index', () => {
  const urlApi = createFakeUrlApi();
  const originalUrl = globalThis.URL;
  const originalWindow = globalThis.window;
  globalThis.URL = urlApi;
  globalThis.window = { location: { protocol: 'https:' } };
  const resources = new ResourceOwnership(urlApi);
  const engine = createBareTts(resources);
  engine.playbackGeneration = 2;
  const activeUrl = urlApi.createObjectURL(new Blob(['active']));
  engine._storeGroupCache(10, [{ text: 'active' }], activeUrl);

  try {
    engine._saveGroupToCache(10, [{ text: 'stale' }], new Blob(['stale']), 1, 'book-a');
    assert.deepEqual(urlApi.revoked, ['blob:https://reader.test/2']);
    assert.equal(resources.has(engine.audioCache.get(10).owner, activeUrl), true);
  } finally {
    globalThis.URL = originalUrl;
    globalThis.window = originalWindow;
  }
});

test('TTS stop, voice change, and container preparation share idempotent cache cleanup', () => {
  const urlApi = createFakeUrlApi();
  const resources = new ResourceOwnership(urlApi);
  const engine = createBareTts(resources);
  const urls = ['stop', 'voice', 'container'].map(value => urlApi.createObjectURL(new Blob([value])));

  engine._storeAudioCache(0, urls[0]);
  engine.stop();
  engine.stop();
  engine._storeAudioCache(0, urls[1]);
  engine.setVoice('other');
  engine._storeAudioCache(0, urls[2]);
  const originalNode = globalThis.Node;
  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  try {
    engine.prepareContainer({
      cloneNode: () => ({ nodeType: 3, nodeValue: ' ', textContent: ' ', childNodes: [] }),
      replaceChildren: () => {},
    });
  } finally {
    globalThis.Node = originalNode;
  }

  assert.deepEqual(urlApi.revoked, urls);
});

test('comic parser registers generated page URLs under the supplied owner', async () => {
  const urlApi = createFakeUrlApi();
  const originalUrl = globalThis.URL;
  globalThis.URL = urlApi;
  const resources = new ResourceOwnership(urlApi);
  const owner = { type: 'comic-page' };
  const zip = {
    forEach(callback) {
      callback('page.png', { dir: false });
    },
    file: () => ({ async: async () => new Blob(['page']) }),
  };
  const originalZip = globalThis.JSZip;
  globalThis.JSZip = { loadAsync: async () => zip };
  const parser = new ComicParser({ name: 'comic.cbz', size: 1 }, resources);

  try {
    const parsed = await parser.parse();
    const url = await parsed.chapters[0].getImageUrl(owner);
    assert.equal(resources.has(owner, url), true);
    resources.revokeOwner(owner);
    assert.deepEqual(urlApi.revoked, [url]);
  } finally {
    globalThis.JSZip = originalZip;
    globalThis.URL = originalUrl;
  }
});
