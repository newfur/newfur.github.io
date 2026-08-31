import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  OperationOwner,
  OwnedDebouncer,
  OwnedLease,
  OwnedValueLock,
  buildOwnedSearchIndex,
  finishTrackedResource,
  ownedCallback,
  completeOwnedTransition,
} from '../../reader/operation-ownership.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('a superseded book operation cannot commit after its await', async () => {
  const owner = new OperationOwner();
  const delayed = deferred();
  const rendered = [];
  const tokenA = owner.begin('book-a');
  const operationA = delayed.promise.then(value => {
    if (owner.isCurrent(tokenA, 'book-a')) rendered.push(value);
  });

  const tokenB = owner.begin('book-b');
  delayed.resolve('stale-a');
  await operationA;

  assert.deepEqual(rendered, []);
  assert.equal(owner.isCurrent(tokenB, 'book-b'), true);
});

test('each chapter request is last-wins within the same book', async () => {
  const owner = new OperationOwner();
  const first = owner.begin('book-a');
  const second = owner.begin('book-a');

  assert.equal(owner.isCurrent(first, 'book-a'), false);
  assert.equal(owner.isCurrent(second, 'book-a'), true);
});

test('invalidate makes a captured close token stale without changing its book id', () => {
  const owner = new OperationOwner();
  const closing = owner.begin('book-a');
  owner.invalidate();

  assert.equal(closing.bookId, 'book-a');
  assert.equal(owner.isCurrent(closing, 'book-a'), false);
  assert.equal(owner.currentToken(), null);
});

test('tokens are immutable snapshots with monotonically increasing generations', () => {
  const owner = new OperationOwner();
  const first = owner.begin('book-a');
  const second = owner.begin('book-b');

  assert.equal(Object.isFrozen(first), true);
  assert.ok(second.generation > first.generation);
  assert.deepEqual(owner.currentToken(), second);
});

test('reader async flows use captured owners and explicit persistence ids', () => {
  const source = fs.readFileSync(new URL('../../reader/reader.js', import.meta.url), 'utf8');

  assert.match(source, /cleanupParserResult\(parsed, parser, parserRequestOwner\)/);
  assert.match(source, /prefetchedChapterCache\.set\(nextIndex, \{ index: nextIndex, html, generation: operation\.generation, bookId: operation\.bookId, owner \}\)/);
  assert.match(source, /if \(!isCurrent\(\)\) \{\s*resourceOwnership\.revokeOwner\(pageOwner\)/);
  assert.match(source, /withResourceOwner\(resourceOwnership, summaryOwner, \(\) => ch\.getContent\(summaryOwner\)\)/);
  assert.match(source, /withResourceOwner\(resourceOwnership, indexOwner, \(\) => chapter\.getContent\(indexOwner\)\)/);
  assert.match(source, /await forceSaveCurrentProgress\(closingBookId\)/);
  assert.match(source, /await forceSaveCurrentProgress\(closingBookId\)[\s\S]*await saveReadingTime\(closingBookId, closingTracker\)/);
  assert.match(source, /pending: library\.updateProgress\(operation\.bookId, progressUpdate\)/);
  assert.doesNotMatch(source, /loadChapter ignored because a chapter change is already in progress/);
  assert.match(source, /finally \{\s*if \(chapterOwner && !chapterMounted\) resourceOwnership\.revokeOwner\(chapterOwner\);\s*if \(isCurrent\(\)\) \{\s*isChangingChapter = false;/);
  assert.match(source, /chapterScrollLock\.release\(scrollLockToken\)/);
});

test('offline artifacts define operation ownership before reader startup', () => {
  for (const output of ['../../index.html', '../../reader_offline.html']) {
    const source = fs.readFileSync(new URL(output, import.meta.url), 'utf8');
    const definition = source.indexOf('class OperationOwner');
    const reader = source.indexOf('const readerOperations = new OperationOwner()');
    assert.ok(definition >= 0, `${output} includes OperationOwner`);
    assert.ok(definition < reader, `${output} defines OperationOwner before use`);
  }
});

test('offline artifacts define resource ownership before TTS and reader startup', () => {
  for (const output of ['../../index.html', '../../reader_offline.html']) {
    const source = fs.readFileSync(new URL(output, import.meta.url), 'utf8');
    const definition = source.indexOf('class ResourceOwnership');
    const tts = source.indexOf('class TTSEngine');
    const reader = source.indexOf('const resourceOwnership = new ResourceOwnership');
    assert.ok(definition >= 0, `${output} includes ResourceOwnership`);
    assert.ok(definition < tts, `${output} defines ResourceOwnership before TTS`);
    assert.ok(definition < reader, `${output} defines ResourceOwnership before reader use`);
  }
});

test('comic URL is untracked and revoked once when progress save becomes stale', async () => {
  const owner = new OperationOwner();
  const token = owner.begin('book-a');
  const save = deferred();
  const activeResources = ['blob:comic-page'];
  const revoked = [];

  const completion = finishTrackedResource({
    url: 'blob:comic-page',
    activeResources,
    pending: save.promise,
    isCurrent: () => owner.isCurrent(token, 'book-a'),
    revoke: url => revoked.push(url)
  });
  owner.begin('book-b');
  save.resolve();

  assert.equal(await completion, false);
  assert.deepEqual(activeResources, []);
  assert.deepEqual(revoked, ['blob:comic-page']);
});

test('stale delayed search index cannot replace the current book caches', async () => {
  const owner = new OperationOwner();
  const tokenA = owner.begin('book-a');
  const delayed = deferred();
  const caches = { chunks: [{ text: 'book-b' }], chapters: [{ text: 'book-b' }] };
  const building = buildOwnedSearchIndex(
    [{ title: 'A', getContent: () => delayed.promise }],
    html => ({ chapterText: html, plainText: html }),
    () => owner.isCurrent(tokenA, 'book-a')
  );

  owner.begin('book-b');
  delayed.resolve('book-a stale content that is deliberately longer than fifty characters');
  const result = await building;
  if (result) {
    caches.chunks = result.chunks;
    caches.chapters = result.chapters;
  }

  assert.equal(result, null);
  assert.deepEqual(caches, { chunks: [{ text: 'book-b' }], chapters: [{ text: 'book-b' }] });
});

test('debounced progress is coalesced per owner and never redirected to a newer book', async () => {
  const owner = new OperationOwner();
  const timers = [];
  const debouncer = new OwnedDebouncer(
    callback => { timers.push(callback); return timers.length - 1; },
    timer => { timers[timer] = null; }
  );
  const writes = [];
  const applied = [];
  const tokenA = owner.begin('book-a');
  debouncer.schedule({
    token: tokenA,
    bookId: 'book-a',
    update: { chapterIndex: 1 },
    isCurrent: (token, bookId) => owner.isCurrent(token, bookId),
    persist: async (bookId, update) => writes.push([bookId, update]),
    apply: update => applied.push(['book-a', update])
  });

  const tokenB = owner.begin('book-b');
  debouncer.schedule({
    token: tokenB,
    bookId: 'book-b',
    update: { chapterIndex: 2 },
    isCurrent: (token, bookId) => owner.isCurrent(token, bookId),
    persist: async (bookId, update) => writes.push([bookId, update]),
    apply: update => applied.push(['book-b', update])
  });
  await Promise.all(timers.filter(Boolean).map(callback => callback()));

  assert.deepEqual(writes, [['book-b', { chapterIndex: 2 }]]);
  assert.deepEqual(applied, [['book-b', { chapterIndex: 2 }]]);
});

test('delayed chapter callback cannot mutate or scroll after its owner becomes stale', () => {
  const owner = new OperationOwner();
  const tokenA = owner.begin('book-a');
  const effects = [];
  const delayedScroll = ownedCallback(
    () => owner.isCurrent(tokenA, 'book-a'),
    () => effects.push('scroll')
  );

  owner.begin('book-b');
  delayedScroll();

  assert.deepEqual(effects, []);
});

test('reader delayed chapter integrations all use the captured owner guard', () => {
  const source = fs.readFileSync(new URL('../../reader/reader.js', import.meta.url), 'utf8');

  assert.match(source, /import \{[^}]*OwnedDebouncer[^}]*ownedCallback[^}]*\} from '.\/operation-ownership\.js'/s);
  assert.match(source, /const scrollToBottom = ownedCallback\(isCurrent/);
  assert.match(source, /img\.addEventListener\('load', scrollToBottom/);
  assert.match(source, /pendingGoToLastPageTimeout = setTimeout\(ownedCallback\(isCurrent/);
  assert.match(source, /return waitForStylesheets\(contentEl\)\.then\(\(\) => \{\s*if \(!isCurrent\(\)\) return;/);
  assert.match(source, /document\.fonts\.ready\.then\(\(\) => \{\s*if \(!isCurrent\(\)\) return;/);
  assert.match(source, /setTimeout\(\(\) => \{\s*chapterScrollLock\.release\(scrollLockToken\);\s*if \(!isCurrent\(\)\) return;/);
});

test('debounced progress reports persistence failures without applying memory state', async () => {
  const callbacks = [];
  const errors = [];
  const debouncer = new OwnedDebouncer(callback => { callbacks.push(callback); return 1; }, () => {});
  debouncer.schedule({
    token: { generation: 1, bookId: 'book-a' },
    bookId: 'book-a',
    update: { chapterIndex: 3 },
    isCurrent: () => true,
    persist: async () => { throw new Error('storage failed'); },
    apply: () => assert.fail('failed persistence must not update memory'),
    onError: error => errors.push(error.message)
  });

  await callbacks[0]();

  assert.deepEqual(errors, ['storage failed']);
});

test('delayed TTS click cannot start playback for a superseded reader owner', () => {
  const owner = new OperationOwner();
  const tokenA = owner.begin('book-a');
  const plays = [];
  const click = ownedCallback(
    () => owner.isCurrent(tokenA, 'book-a'),
    () => plays.push('book-a')
  );

  owner.begin('book-b');
  click();

  assert.deepEqual(plays, []);
});

test('playback end cannot restart TTS after chapter loading becomes stale', async () => {
  const owner = new OperationOwner();
  const tokenA = owner.begin('book-a');
  const chapterLoad = deferred();
  let session = 7;
  const plays = [];
  const completion = completeOwnedTransition({
    pending: chapterLoad.promise,
    isCurrent: () => owner.isCurrent(tokenA, 'book-a') && session === 7,
    complete: () => plays.push('book-a')
  });

  owner.begin('book-b');
  session = 8;
  chapterLoad.resolve();

  assert.equal(await completion, false);
  assert.deepEqual(plays, []);
});

test('reader TTS timers and playback completion use captured ownership', () => {
  const source = fs.readFileSync(new URL('../../reader/reader.js', import.meta.url), 'utf8');

  assert.match(source, /const clickOperation = readerOperations\.currentToken\(\)/);
  assert.match(source, /tts\.play\(sentenceIdx, true, clickBookId\)/);
  assert.match(source, /function clearTTSClickTimer\(\)/);
  assert.match(source, /completeOwnedTransition\(\{/);
  assert.match(source, /tts\._isCurrentSession\(ttsSessionId, ttsOwnerBookId\)/);
  assert.match(source, /tts\.play\(0, false, playbackBookId\)/);
});

test('old TTS callback during delayed new-book open cannot update the new book', () => {
  const owner = new OperationOwner();
  const tokenA = owner.begin('book-a');
  let ttsGeneration = 3;
  let ttsBookId = 'book-a';
  const writes = [];
  const bookB = { id: 'book-b', progress: {} };
  let currentBook = { id: 'book-a', progress: {} };
  const oldCallback = ownedCallback(
    () => owner.isCurrent(tokenA, 'book-a') && currentBook.id === 'book-a' && ttsGeneration === 3 && ttsBookId === 'book-a',
    () => writes.push('book-a')
  );

  owner.invalidate();
  ttsGeneration = 4;
  ttsBookId = null;
  currentBook = bookB;
  oldCallback();

  assert.deepEqual(writes, []);
  assert.deepEqual(bookB.progress, {});
});

test('stale close cannot stop a newer book reading tracker lease after its save await', async () => {
  const leases = new OwnedLease();
  const trackerA = leases.acquire('book-a');
  const saveA = deferred();
  const closingA = (async () => {
    await saveA.promise;
    return leases.release(trackerA);
  })();
  const trackerB = leases.acquire('book-b');
  saveA.resolve();

  assert.equal(await closingA, false);
  assert.equal(leases.isCurrent(trackerB), true);
});

test('stale delayed selection callback cannot run for a new book', () => {
  const owner = new OperationOwner();
  const tokenA = owner.begin('book-a');
  const selections = [];
  const delayedSelection = ownedCallback(
    () => owner.isCurrent(tokenA, 'book-a'),
    selection => selections.push(selection)
  );

  owner.begin('book-b');
  delayedSelection('selection-a');

  assert.deepEqual(selections, []);
});

test('reader cross-book shared state is guarded by captured ownership', () => {
  const source = fs.readFileSync(new URL('../../reader/reader.js', import.meta.url), 'utf8');

  assert.match(source, /function beginReaderOperation\(bookId, stopTTS = false\) \{[\s\S]*if \(stopTTS\) tts\.stop\(\)/);
  assert.match(source, /beginReaderOperation\(id, true\)/);
  assert.match(source, /tts\.onSentenceStart = \(index, sessionId, ownerBookId\)/);
  assert.match(source, /readerOperations\.isCurrent\(operation, ownerBookId\)/);
  assert.match(source, /const closingTracker = readingTrackerLease\.current\(\)/);
  assert.match(source, /if \(!readerOperations\.isCurrent\(operation, closingBookId\)\) return;\s*stopReadingTracker\(closingTracker\)/);
  assert.match(source, /saveReadingTime\(closingBookId, closingTracker\)/);
  assert.match(source, /function clearSelectionChangeTimer\(\)/);
  assert.match(source, /const selectionOperation = readerOperations\.currentToken\(\)/);
});

test('overlapping chapter locks restore original overflow only after every owner releases', async () => {
  const style = { html: 'auto', body: 'scroll' };
  const lock = new OwnedValueLock(
    () => ({ ...style }),
    value => Object.assign(style, value),
    { html: 'hidden', body: 'hidden' }
  );
  const releaseA = deferred();
  const releaseB = deferred();
  const tokenA = lock.acquire('chapter-a');
  const operationA = releaseA.promise.then(() => lock.release(tokenA));
  const tokenB = lock.acquire('chapter-b');
  const operationB = releaseB.promise.then(() => lock.release(tokenB));

  releaseA.resolve();
  await operationA;
  assert.deepEqual(style, { html: 'hidden', body: 'hidden' });

  releaseB.resolve();
  await operationB;
  assert.deepEqual(style, { html: 'auto', body: 'scroll' });
});

test('reset restores overflow before invalidating old locks and supports a reopened owner', () => {
  const style = { html: 'auto', body: 'scroll' };
  const writes = [];
  const lock = new OwnedValueLock(
    () => ({ ...style }),
    value => {
      writes.push({ ...value });
      Object.assign(style, value);
    },
    { html: 'hidden', body: 'hidden' }
  );
  const tokenA = lock.acquire('chapter-a');

  lock.reset();
  assert.deepEqual(style, { html: 'auto', body: 'scroll' });
  const tokenB = lock.acquire('chapter-b');

  assert.deepEqual(style, { html: 'hidden', body: 'hidden' });
  assert.equal(lock.release(tokenA), false);
  assert.deepEqual(style, { html: 'hidden', body: 'hidden' });
  assert.equal(lock.release(tokenB), true);
  assert.deepEqual(style, { html: 'auto', body: 'scroll' });
  lock.reset();
  assert.deepEqual(style, { html: 'auto', body: 'scroll' });
  assert.deepEqual(writes, [
    { html: 'hidden', body: 'hidden' },
    { html: 'auto', body: 'scroll' },
    { html: 'hidden', body: 'hidden' },
    { html: 'auto', body: 'scroll' }
  ]);
});

test('reader generation invalidation resets chapter scroll lock before close overflow reset', () => {
  const source = fs.readFileSync(new URL('../../reader/reader.js', import.meta.url), 'utf8');

  assert.match(source, /function invalidateReaderOperation\(\) \{\s*chapterScrollLock\.reset\(\);\s*readerOperations\.invalidate\(\);\s*\}/);
  assert.match(source, /invalidateReaderOperation\(\);[\s\S]*document\.documentElement\.style\.overflow = '';\s*document\.body\.style\.overflow = '';/);
});
