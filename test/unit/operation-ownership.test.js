import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { OperationOwner } from '../../reader/operation-ownership.js';

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

  assert.match(source, /cleanupParserResult\(parsed, parser\)/);
  assert.match(source, /prefetchedChapterCache = \{ index: nextIndex, html, generation: operation\.generation, bookId: operation\.bookId \}/);
  assert.match(source, /if \(!isCurrent\(\)\) \{\s*if \(url\?\.startsWith\('blob:'\)\) URL\.revokeObjectURL\(url\)/);
  assert.match(source, /await forceSaveCurrentProgress\(closingBookId\)/);
  assert.match(source, /await forceSaveCurrentProgress\(closingBookId\)[\s\S]*await saveReadingTime\(closingBookId\)/);
  assert.match(source, /await library\.updateProgress\(operation\.bookId, progressUpdate\);\s*if \(!isCurrent\(\)\) return;/);
  assert.doesNotMatch(source, /loadChapter ignored because a chapter change is already in progress/);
  assert.match(source, /finally \{\s*if \(!isCurrent\(\)\) return;\s*isChangingChapter = false;/);
});
