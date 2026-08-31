import test from 'node:test';
import assert from 'node:assert/strict';

import { TTSEngine } from '../../reader/tts.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function bareEngine() {
  const engine = Object.create(TTSEngine.prototype);
  Object.assign(engine, {
    playbackGeneration: 0,
    activeRequests: new Set(),
    retryTimers: new Set(),
    audioCache: new Map(),
    fetchingIndices: new Set(),
    sentences: [{ text: 'hello', chapterIndex: 0 }],
    selectedVoice: { name: 'voice', type: 'openai' },
    voices: [{ name: 'voice', type: 'openai' }, { name: 'other', type: 'openai' }],
    ownerBookId: 'book-a',
    currentIndex: 0,
    currentlyPlayingIndex: -1,
    isPlaying: true,
    playbackStarted: true,
    currentChapterIndex: 0,
    prefetchedChapterIndex: null,
    nativeQueue: new Set(),
    players: [],
    synth: null,
    ttsProvider: 'openai',
    ttsEndpoint: '',
    ttsApiKey: '',
    ttsModel: 'tts-1',
    consecutiveWsFailures: 0,
  });
  return engine;
}

test('starting a session cancels every active request exactly once', () => {
  const engine = bareEngine();
  let cancellations = 0;
  engine.activeRequests.add({ cancel: () => { cancellations += 1; } });

  const session = engine._beginSession('book-a');
  engine._cancelActiveRequests('again');

  assert.equal(session, 1);
  assert.equal(cancellations, 1);
  assert.equal(engine.activeRequests.size, 0);
});

test('stop invalidates a delayed download so it cannot populate cache', async () => {
  const engine = bareEngine();
  const download = deferred();
  engine._downloadSentenceAudio = () => download.promise;
  const session = engine._beginSession('book-a');

  const fetching = engine._fetchSentence(0, 0, session, 'book-a');
  engine.stop();
  download.resolve(new Blob(['audio']));
  await fetching;

  assert.equal(engine.audioCache.has(0), false);
  assert.equal(engine.fetchingIndices.has(0), false);
  assert.ok(engine.playbackGeneration > session);
});

test('HTTP downloads receive an abort signal owned by the session', async () => {
  const engine = bareEngine();
  let signal;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };

  try {
    const session = engine._beginSession('book-a');
    const request = engine._downloadSentenceAudio(engine.sentences[0], session, 'book-a');
    engine.stop();
    await assert.rejects(request);
    assert.equal(signal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WebSocket timeout closes the socket and error plus close settles once', async () => {
  const engine = bareEngine();
  engine.ttsProvider = 'edge';
  engine._generateSecMsGecToken = async () => 'token';
  engine.requestTimeoutMs = 100;
  const timers = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalWebSocket = globalThis.WebSocket;
  const originalWindow = globalThis.window;
  globalThis.window = { location: { protocol: 'https:', host: 'reader.test' } };
  globalThis.setTimeout = callback => { timers.push(callback); return timers.length; };
  globalThis.clearTimeout = () => {};
  let socket;
  class FakeWebSocket {
    static CLOSING = 2;
    constructor() { this.readyState = 0; this.closeCalls = 0; socket = this; }
    close() { this.closeCalls += 1; this.readyState = 3; this.onclose?.(); }
    send() {}
  }
  globalThis.WebSocket = FakeWebSocket;

  try {
    const session = engine._beginSession('book-a');
    const request = engine._downloadSentenceAudio(engine.sentences[0], session, 'book-a');
    await Promise.resolve();
    timers[0]();
    socket.onerror?.(new Error('late error'));
    await assert.rejects(request, /timed out/i);
    assert.equal(socket.closeCalls, 1);
    assert.equal(engine.activeRequests.size, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.WebSocket = originalWebSocket;
    globalThis.window = originalWindow;
  }
});

test('voice changes invalidate old playback and clear retry timers', () => {
  const engine = bareEngine();
  const session = engine._beginSession('book-a');
  engine.isPlaying = false;
  let cleared = 0;
  engine.retryTimers.add(42);
  engine._clearTimer = () => { cleared += 1; };

  engine.setVoice('other');

  assert.equal(engine._isCurrentSession(session, 'book-a'), false);
  assert.equal(cleared, 1);
  assert.equal(engine.retryTimers.size, 0);
});

test('a chapter transition from an obsolete session cannot highlight', async () => {
  const engine = bareEngine();
  const transition = deferred();
  let highlights = 0;
  engine.onChapterTransition = () => transition.promise;
  engine._highlightSentence = () => { highlights += 1; };
  const session = engine._beginSession('book-a');

  const completion = engine._runOwnedTransition(1, session, 'book-a', () => engine._highlightSentence(engine.sentences[0]));
  engine._beginSession('book-b');
  transition.resolve();
  await completion;

  assert.equal(highlights, 0);
});

test('stalled HTTP download times out, aborts, and unregisters exactly once', async () => {
  const engine = bareEngine();
  engine.requestTimeoutMs = 100;
  const timers = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalFetch = globalThis.fetch;
  let aborts = 0;
  globalThis.setTimeout = callback => { timers.push(callback); return timers.length; };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborts += 1; reject(options.signal.reason); }, { once: true });
  });

  try {
    const session = engine._beginSession('book-a');
    const request = engine._downloadSentenceAudio(engine.sentences[0], session, 'book-a');
    timers[0]();
    timers[0]();
    await assert.rejects(request, /timed out/i);
    assert.equal(aborts, 1);
    assert.equal(engine.activeRequests.size, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.fetch = originalFetch;
  }
});

test('stalled native download times out, cancels best effort, and unregisters exactly once', async () => {
  const engine = bareEngine();
  engine.ttsProvider = 'edge';
  engine.requestTimeoutMs = 100;
  engine._generateSecMsGecToken = async () => 'token';
  const download = deferred();
  const timers = [];
  let cancellations = 0;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  globalThis.setTimeout = callback => { timers.push(callback); return timers.length; };
  globalThis.clearTimeout = () => {};
  globalThis.window = {
    location: { protocol: 'capacitor:', host: '' },
    Capacitor: { Plugins: { NativeTTS: {
      downloadTTS: () => download.promise,
      cancelTTS: async () => { cancellations += 1; }
    } } }
  };
  globalThis.WebSocket = class { constructor() { throw new Error('stale native request opened WebSocket'); } };

  try {
    const session = engine._beginSession('book-a');
    const request = engine._downloadSentenceAudio(engine.sentences[0], session, 'book-a');
    await Promise.resolve();
    timers[0]();
    timers[0]();
    await assert.rejects(request, /timed out/i);
    assert.equal(cancellations, 1);
    assert.equal(engine.activeRequests.size, 0);
    download.resolve({ audioBase64: '' });
    await Promise.resolve();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
  }
});

test('WebSocket cancellation settles as abort before synchronous close callbacks', async () => {
  const engine = bareEngine();
  engine.ttsProvider = 'edge';
  engine._generateSecMsGecToken = async () => 'token';
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  globalThis.window = { location: { protocol: 'https:', host: 'reader.test' } };
  let socket;
  class FakeWebSocket {
    static CLOSING = 2;
    constructor() { this.readyState = 0; this.closeCalls = 0; socket = this; }
    close() { this.closeCalls += 1; this.readyState = 3; this.onclose?.(); }
    send() {}
  }
  globalThis.WebSocket = FakeWebSocket;

  try {
    const session = engine._beginSession('book-a');
    const request = engine._downloadSentenceAudio(engine.sentences[0], session, 'book-a');
    await Promise.resolve();
    engine.stop();
    await assert.rejects(request, error => error?.name === 'AbortError');
    assert.equal(socket.closeCalls, 1);
    assert.equal(engine.activeRequests.size, 0);
  } finally {
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
  }
});

test('timeout during token generation prevents late native or WebSocket startup', async () => {
  const engine = bareEngine();
  engine.ttsProvider = 'edge';
  const token = deferred();
  engine._generateSecMsGecToken = () => token.promise;
  const timers = [];
  let nativeStarts = 0;
  let socketStarts = 0;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  globalThis.setTimeout = callback => { timers.push(callback); return timers.length; };
  globalThis.clearTimeout = () => {};
  globalThis.window = {
    location: { protocol: 'capacitor:', host: '' },
    Capacitor: { Plugins: { NativeTTS: { downloadTTS: () => { nativeStarts += 1; } } } }
  };
  globalThis.WebSocket = class { constructor() { socketStarts += 1; } };

  try {
    const session = engine._beginSession('book-a');
    const request = engine._downloadSentenceAudio(engine.sentences[0], session, 'book-a');
    timers[0]();
    await assert.rejects(request, /timed out/i);
    token.resolve('late-token');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(nativeStarts, 0);
    assert.equal(socketStarts, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
  }
});
