import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { AIEngine } from '../../reader/ai.js';

function context(bookId = 'book-a') {
  let current = true;
  const value = { bookId, generation: 1, controller: new AbortController(), isCurrent: () => current };
  return { value, invalidate: () => { current = false; value.controller.abort(); } };
}

test('direct streaming passes the owner abort signal to fetch', async () => {
  const engine = new AIEngine();
  const owned = context();
  const originalFetch = globalThis.fetch;
  let signal;
  globalThis.fetch = (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };

  try {
    const request = engine._streamDirect('openai', '', '', '', [], () => {}, owned.value);
    owned.invalidate();
    await assert.rejects(request);
    assert.equal(signal, owned.value.controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stale direct stream chunks are ignored', async () => {
  const engine = new AIEngine();
  const owned = context();
  const encoder = new TextEncoder();
  const reads = [
    { done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"old"}}]}\n') },
    { done: true }
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, body: { getReader: () => ({ read: async () => reads.shift(), cancel: async () => {} }) } });
  const chunks = [];

  try {
    owned.invalidate();
    await assert.rejects(engine._streamDirect('openai', '', '', '', [], chunk => chunks.push(chunk), owned.value), /stale|abort/i);
    assert.deepEqual(chunks, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('extension cancellation disconnects its port and settles once', async () => {
  const engine = new AIEngine();
  const owned = context();
  const messages = [];
  const disconnects = [];
  const port = {
    onMessage: { addListener: listener => messages.push(listener), removeListener() {} },
    onDisconnect: { addListener: listener => disconnects.push(listener), removeListener() {} },
    postMessage() {},
    disconnectCalls: 0,
    disconnect() { this.disconnectCalls += 1; disconnects.forEach(listener => listener()); }
  };
  const originalChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { connect: () => port, lastError: null } };

  try {
    const request = engine._streamExtension('openai', '', '', '', [], () => {}, owned.value);
    owned.invalidate();
    await assert.rejects(request);
    messages[0]({ type: 'error', message: 'late' });
    assert.equal(port.disconnectCalls, 1);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('an old built-in request destroys only the session it created', async () => {
  const engine = new AIEngine();
  const oldSession = { prompt: async () => 'old', destroyCalls: 0, destroy() { this.destroyCalls += 1; } };
  const newSession = { prompt: async () => 'new', destroyCalls: 0, destroy() { this.destroyCalls += 1; } };
  engine.session = newSession;
  const owned = context();

  await engine._streamPrompt('prompt', () => {}, owned.value, oldSession);

  assert.equal(oldSession.destroyCalls, 1);
  assert.equal(newSession.destroyCalls, 0);
  assert.equal(engine.session, newSession);
});

test('stale built-in chunks never reach the UI callback', async () => {
  const engine = new AIEngine();
  const owned = context();
  async function* stream() {
    owned.invalidate();
    yield 'stale';
  }
  const session = { promptStreaming: () => stream(), destroy() {} };
  const chunks = [];

  await assert.rejects(engine._streamPrompt('prompt', chunk => chunks.push(chunk), owned.value, session), /stale|abort/i);
  assert.deepEqual(chunks, []);
});

test('reader AI persistence is bound to the captured source book', () => {
  const source = fs.readFileSync(new URL('../../reader/reader.js', import.meta.url), 'utf8');

  assert.match(source, /await library\.saveAIChat\(context\.bookId, chat\)/);
  assert.match(source, /if \(context\.isCurrent\(\)\) currentBook\.aiChats = updatedChats/);
  assert.match(source, /await library\.saveBookSummary\(aiContext\.bookId, finalReply\)/);
  assert.match(source, /await library\.saveChapterSummary\(aiContext\.bookId, i, chSummary\)/);
  assert.doesNotMatch(source, /library\.saveAIChat\(currentBook\.id/);
});
