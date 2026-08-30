# Data and Async Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate lost IndexedDB updates, stale cross-book writes, stale playback, uncancellable network work, and unbounded object URL retention.

**Architecture:** Centralize single-book mutation in one transaction-scoped primitive. Add explicit operation ownership and generation IDs to reader, AI, TTS, and resource lifecycles so only the current owner may commit effects.

**Tech Stack:** Browser ESM, IndexedDB, fake-indexeddb, WebSocket/fetch cancellation, Node `node:test`.

**Module Boundary:** This plan relies on `reader/package.json` and `test/package.json` with `{ "type": "module" }`, created by the content-security plan. The root remains CommonJS for build/server scripts.

---

### Task 1: Add atomic book mutation

**Files:**
- Modify: `reader/library.js`
- Create: `test/unit/library-atomic.test.js`

- [ ] **Step 1: Write concurrent-update and abort tests**

```js
test('progress and statistics updates both survive concurrency', async () => {
  await Promise.all([
    library.updateProgress('book', { chapterIndex: 3 }),
    library.addReadingDuration('book', 10)
  ]);
  const book = await library.getBook('book');
  assert.equal(book.progress.chapterIndex, 3);
  assert.equal(book.stats.totalTime, 10);
});
```

Also test concurrent notes/chats, transaction abort preserving the old record, and rejection of Promise-returning updater callbacks.

- [ ] **Step 2: Verify the existing read-then-put implementation loses a field**

Run: `node --test test/unit/library-atomic.test.js`

Expected: FAIL with missing progress or statistics.

- [ ] **Step 3: Replace `updateBook(book)` with one-transaction `updateBook(id, updater)`**

```js
async updateBook(id, updater) {
  await this._ensureOpen();
  return new Promise((resolve, reject) => {
    const tx = this.db.transaction(['books'], 'readwrite');
    const store = tx.objectStore('books');
    let result;
    const request = store.get(id);
    request.onsuccess = () => {
      if (!request.result) return tx.abort();
      const draft = structuredClone(request.result);
      result = updater(draft) ?? draft;
      if (result && typeof result.then === 'function') return tx.abort();
      store.put(this._cleanBookForStorage(result));
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Book update aborted'));
  });
}
```

- [ ] **Step 4: Migrate every single-book mutator**

Convert progress, cover, folder, notes, bookmarks, statistics, AI chats, summaries, replacement, and deletion helpers to call `updateBook(id, synchronousUpdater)` and derive return values from the committed result.

- [ ] **Step 5: Run and commit**

Run: `node --test test/unit/library-atomic.test.js`

Expected: PASS.

```sh
git add reader/library.js test/unit/library-atomic.test.js
git commit -m "fix: make book updates atomic"
```

### Task 2: Define replacement and restore semantics

**Files:**
- Modify: `reader/library.js:110-307`
- Modify: `reader/reader.js:2300-2405,9885-10085`
- Create: `test/unit/library-merge.test.js`

- [ ] **Step 1: Add pure merge tests**

Test file replacement clearing `bookSummary`, `chapterSummaries`, and content indexes; metadata-only restore retaining them; selected progress precedence; backup-file precedence when file restoration is selected; annotations merged by stable ID.

- [ ] **Step 2: Add pure helpers and verify tests pass**

```js
export function resetContentDerivedState(book) {
  const next = { ...book };
  delete next.bookSummary;
  next.chapterSummaries = {};
  delete next.searchIndex;
  delete next.ragIndex;
  return next;
}

export function mergeById(current = [], incoming = [], key) {
  const merged = new Map(current.map(item => [item[key], item]));
  for (const item of incoming) merged.set(item[key], { ...merged.get(item[key]), ...item });
  return [...merged.values()];
}
```

Run: `node --test test/unit/library-merge.test.js`

Expected: PASS.

- [ ] **Step 3: Use the helpers inside atomic replacement/import transactions**

Remove the UI-side `{ ...existingBook, ...incomingBookData }` merge. Return the committed replacement from `replaceBookContent()` and assign that record to in-memory state.

- [ ] **Step 4: Commit**

```sh
git add reader/library.js reader/reader.js test/unit/library-merge.test.js
git commit -m "fix: make restore and replacement semantics explicit"
```

### Task 3: Add reader operation ownership

**Files:**
- Create: `reader/operation-ownership.js`
- Modify: `reader/reader.js:60-160,2889-3159,3607-4070`
- Create: `test/unit/operation-ownership.test.js`

- [ ] **Step 1: Write stale-open, chapter, comic, and close tests**

Assert delayed book A operations cannot render or save to book B, and stale comic URLs are revoked.

- [ ] **Step 2: Implement a monotonic owner**

```js
export class OperationOwner {
  #generation = 0;
  begin(bookId) { return Object.freeze({ generation: ++this.#generation, bookId }); }
  invalidate() { this.#generation += 1; }
  isCurrent(token, bookId) {
    return token?.generation === this.#generation && token.bookId === bookId;
  }
}
```

- [ ] **Step 3: Capture and validate ownership around every await**

`openBook`, `closeCurrentBook`, `loadChapter`, `loadComicPage`, stylesheet waits, transitions, delayed timers, progress saves, language detection, and chapter prefetch must capture `{generation, bookId}` and return through request-local cleanup if stale.

- [ ] **Step 4: Make save helpers accept explicit book IDs**

Change `saveReadingTime()` and `forceSaveCurrentProgress()` so they never discover the target through mutable `currentBook` after an await.

- [ ] **Step 5: Run and commit**

Run: `node --test test/unit/operation-ownership.test.js`

Expected: PASS.

```sh
git add reader/operation-ownership.js reader/reader.js test/unit/operation-ownership.test.js
git commit -m "fix: bind reader operations to book generations"
```

### Task 4: Make TTS requests cancellable and session-owned

**Files:**
- Modify: `reader/tts.js:71-228,1045-1508,1573-2219,2084-2543`
- Create: `test/unit/tts-session.test.js`

- [ ] **Step 1: Add fake WebSocket/audio tests**

Cover timeout closing the socket, stop invalidating old requests, stale completion not caching/playing, `onerror` plus `onclose` settling once, voice change cancelling old work, retry timer cleanup, and stale chapter transition not highlighting.

- [ ] **Step 2: Add session/request state**

```js
this.playbackGeneration = 0;
this.activeRequests = new Set();

_beginSession() { this._cancelActiveRequests('superseded'); return ++this.playbackGeneration; }
_isCurrentSession(id) { return id === this.playbackGeneration; }
```

- [ ] **Step 3: Give every transport one exactly-once finalizer**

```js
let settled = false;
const finish = (error, value) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeoutId);
  this.activeRequests.delete(request);
  if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
  error ? reject(error) : resolve(value);
};
```

Register fetch `AbortController`, browser WebSocket, native request handle, retry timers, and silence keep-alive under the captured session. Classify cancellation, timeout, network, protocol, and incomplete-audio errors.

- [ ] **Step 4: Guard all playback callbacks**

Before cache insertion, `audio.play()`, index mutation, highlight, media update, chapter transition completion, speech-synthesis callbacks, retry, and prefetch append, require `this._isCurrentSession(sessionId)` and matching owner book ID.

- [ ] **Step 5: Run and commit**

Run: `node --test test/unit/tts-session.test.js`

Expected: PASS.

```sh
git add reader/tts.js test/unit/tts-session.test.js
git commit -m "fix: make TTS sessions cancellable and stale-safe"
```

### Task 5: Bind AI streaming and persistence to the originating book

**Files:**
- Modify: `reader/ai.js:89-329`
- Modify: `reader/reader.js:8583-9113`
- Create: `test/unit/ai-ownership.test.js`

- [ ] **Step 1: Add delayed and streaming response tests**

Start a query in A, switch to B, then resolve/stream. Assert persistence uses A, B DOM/currentBook remains unchanged, stale chunks are ignored, fetch aborts, extension ports disconnect, and built-in session cleanup cannot destroy a newer session.

- [ ] **Step 2: Pass an operation context through all AI transports**

```js
const context = {
  bookId: currentBook.id,
  owner: readerOperations.currentToken(),
  controller: new AbortController()
};
```

`_streamDirect` uses `signal`; `_streamExtension` owns/disconnects its port; `_streamPrompt` destroys only the session it created. All use one finalizer and check context before `onChunk`.

- [ ] **Step 3: Separate persistence from active UI rendering**

Always save using captured `context.bookId`. Render or mutate `currentBook` only when the reader owner is still current for that book.

- [ ] **Step 4: Run and commit**

Run: `node --test test/unit/ai-ownership.test.js`

Expected: PASS.

```sh
git add reader/ai.js reader/reader.js test/unit/ai-ownership.test.js
git commit -m "fix: bind AI responses to their originating book"
```

### Task 6: Centralize object URL ownership

**Files:**
- Create: `reader/resource-ownership.js`
- Modify: `reader/reader.js`
- Modify: `reader/parsers/epub-parser.js`
- Modify: `reader/parsers/azw3-parser.js`
- Modify: `reader/parsers/comic-parser.js`
- Modify: `reader/tts.js`
- Create: `test/unit/resource-ownership.test.js`

- [ ] **Step 1: Add lifecycle tests**

Cover chapter replacement, page replacement, cancelled open, close-book, bounded cache eviction, stale parser return, TTS group URL single revocation, and duplicate cleanup.

- [ ] **Step 2: Implement owner-keyed registries**

```js
export class ResourceOwnership {
  #owners = new Map();
  register(owner, url) {
    if (!url?.startsWith('blob:')) return url;
    if (!this.#owners.has(owner)) this.#owners.set(owner, new Set());
    this.#owners.get(owner).add(url);
    return url;
  }
  revokeOwner(owner) {
    for (const url of this.#owners.get(owner) || []) URL.revokeObjectURL(url);
    this.#owners.delete(owner);
  }
}
```

- [ ] **Step 3: Migrate parser/page/TTS resources**

Make chapter content return its owner/resources, retain one comic page owner, register open-request resources before global attachment, and centralize TTS cache eviction so group references revoke one URL once.

- [ ] **Step 4: Run and commit**

Run: `node --test test/unit/resource-ownership.test.js`

Expected: PASS.

```sh
git add reader/resource-ownership.js reader/reader.js reader/parsers reader/tts.js test/unit/resource-ownership.test.js
git commit -m "fix: bound object URLs to operation lifecycles"
```
