# Security Audit Remediation Design

Date: 2026-08-30
Status: Approved design

## Objective

Remediate every confirmed issue from the repository-wide security and quality review across the web reader, browser extension, offline build, Node server, Android bridge, TTS engine, IndexedDB persistence, dependency graph, and release workflow.

The work will be implemented as one coordinated refactor rather than a sequence of temporary compatibility patches. Completion requires regression coverage and fresh verification for every finding. A finding may be closed only when it is fixed, disproven with evidence, or bounded by an explicitly tested platform limitation.

## Confirmed Decisions

- New production and development dependencies are allowed.
- Major dependency and toolchain upgrades are allowed, including upgrading the complete Capacitor dependency set to a compatible 8.x release.
- Imported book content uses a permissive allowlist: retain common complex EPUB formatting and safe static SVG while removing executable or externally active content.
- The offline single-file build must inline every functional script, including Mermaid. Network fonts will not be embedded; offline rendering will use local font fallbacks.
- The Node development server listens on localhost by default. LAN access requires explicit configuration.
- Until production signing secrets exist, Android APK releases are clearly marked prereleases rather than stable releases.
- Unsafe native APIs do not retain backward-compatible path handling. All in-repository callers migrate to controlled URI-based interfaces.

## Architecture

### 1. Content Security Boundary

Introduce DOMPurify as the common HTML sanitization implementation. Every path that creates HTML from untrusted data must pass through the same policy before the result enters the application DOM:

- EPUB chapter markup
- FB2 content
- MOBI and AZW3 content
- imported Markdown
- AI-generated Markdown and Mermaid-adjacent content
- imported book metadata and folder names when rendered as markup

Parsers remain responsible for archive extraction, path resolution, and conversion of local resources to controlled object URLs. Sanitization happens after resource rewriting and before chapter prefetch caching or DOM insertion.

The permissive policy retains normal text and layout elements, tables, images, EPUB-specific semantic elements, common style attributes, and safe static SVG. It always removes:

- scripts and executable SVG
- event-handler attributes
- forms and form controls
- `iframe`, `object`, `embed`, and equivalent active content
- SVG animation, `foreignObject`, and external SVG references
- dangerous URL schemes such as `javascript:` and unsafe `data:` forms
- external active resources not required by the reader
- executable or document-escaping CSS constructs

Internal ebook links become `data-epub-href` actions. External links are restricted to approved schemes such as `http:`, `https:`, and `mailto:` and receive `rel="noopener noreferrer"`. Images may use reader-created `blob:` URLs, approved `data:image/*` content, and explicitly supported HTTP(S) sources.

The web server and static deployment add CSP, `X-Content-Type-Options`, referrer, framing, and permissions policies as defense in depth. CSP does not replace sanitization.

If sanitization rejects individual elements, the chapter continues loading without those elements. If parsing the chapter fails, the reader displays an escaped error state and never inserts the original untrusted markup as a fallback.

### 2. Controlled Capability Boundary

#### Node server

Static requests are decoded and normalized before allowlist selection. Each allowed mount has its own resolved root, and the final resolved path must remain beneath that exact root using a separator-safe containment check. A request accepted as `/reader/` cannot normalize into the repository root or another mount.

The server listens on `127.0.0.1` by default. Explicit LAN binding requires configuration. The TTS WebSocket proxy validates the request path and Origin, limits payload size, bounds queued messages and queued bytes, caps concurrent connections, applies connection and idle timeouts, and propagates backpressure or closes the client rather than buffering indefinitely.

#### Android native bridge

File export accepts only:

- files created by the plugin under approved app-owned cache/files roots and represented by controlled URIs; or
- `content://` URIs for which Android granted read access.

Arbitrary `file://` and absolute paths are rejected. Source and destination files are canonicalized and checked against approved roots. Error responses use stable error codes and do not expose private absolute paths.

ZIP creation accepts only approved source directories and controlled output names. It rejects absolute paths, `..` traversal, symbolic links, and any recursive entry whose canonical path leaves the source root.

Android API 23-28 exports use the Storage Access Framework instead of legacy direct public-storage writes. Android 13 and newer receive notification-permission handling with a documented degraded path when permission is denied.

### 3. Atomic Persistence and Session Ownership

#### IndexedDB

Add one `updateBook(id, updater)` primitive. It opens a single `readwrite` transaction, reads the book, applies a synchronous updater, cleans the record for storage, writes it, and resolves only when the transaction commits.

The updater must not await network, timers, or other asynchronous work because IndexedDB may close an inactive transaction. All progress, cover, folder, note, bookmark, reading-statistics, AI chat, chapter-summary, book-summary, and restore merge operations migrate to this primitive.

Restore behavior explicitly defines field precedence:

- a backup file replaces the existing file when the user selected restoration of file contents;
- current or backup progress follows the restore option selected by the user;
- independent annotation collections merge by stable IDs without dropping concurrent changes;
- replacing a book file clears summaries and indexes derived from the old content.

UI state changes only after transaction commit. Transaction aborts preserve the existing UI state and surface a retryable error.

#### TTS, chapters, and AI

The reader and TTS engine use monotonically increasing generation IDs. Starting playback, stopping, switching books, changing voice, or beginning an incompatible chapter operation invalidates earlier generations.

Every asynchronous chapter load, chapter transition, audio fetch, prefetch, native service startup, AI request, and streaming reader captures its generation and stable book identity. Before changing state, rendering UI, appending prefetched data, saving progress, or starting audio, it verifies that its generation and owner still match.

AI responses persist only to the captured `bookId`. If navigation changed the active UI generation, a completed response may be stored in its original book history but must not render in the newly opened book.

WebSocket and native TTS requests are registered by session. Stop and session invalidation close active sockets, cancel native requests where supported, clear timers, stop silent keep-alive audio, and remove request bookkeeping. A single finalizer resolves or rejects each operation exactly once.

TTS failures distinguish timeout, cancellation, network failure, protocol failure, and empty or incomplete audio. User cancellation does not display an error notification.

### 4. Resource Lifecycle

Object URLs are owned by a book-open request, chapter render, or comic page render rather than one unbounded global session list.

- Replacing a chapter revokes resources owned by the previous chapter after the old DOM no longer uses them.
- Replacing a comic page revokes the previous page URL.
- Cancelling an obsolete open request releases resources created by that request before returning.
- Closing a book releases all remaining resources owned by the book.
- Repeated chapter visits may reuse a bounded cache, but cache eviction must revoke its object URLs.

### 5. Dependencies and Build Outputs

Upgrade `@capacitor/core`, `@capacitor/android`, `@capacitor/cli`, `@capacitor/filesystem`, and `@capacitor/share` to compatible 8.x versions. Upgrade Node, Gradle, Android Gradle Plugin, SDK levels, and Java requirements as required by that Capacitor release. Preserve the Android application ID and the effective WebView origin so existing IndexedDB libraries remain accessible.

Commit `package-lock.json`, remove it from `.gitignore`, and use `npm ci` in CI. High or critical dependency advisories fail the release unless a repository audit exception documents the advisory, bounded exposure, owner, and expiration date.

The offline build inlines all functional JavaScript dependencies, including Mermaid. It removes or tolerates network font references and provides local system-font fallbacks. Automated validation copies only the generated HTML into an empty directory, blocks network access, and exercises advertised functionality.

The Capacitor build includes only resources required by the mobile WebView. It does not register a PWA service worker where that has no useful mobile behavior. Every local `src` and `href` emitted into the mobile artifact must resolve inside the build output.

### 6. Release Supply Chain

CI performs validation before pushing generated output or publishing artifacts:

1. install locked dependencies with `npm ci`;
2. run JavaScript and security regression tests;
3. run the dependency audit;
4. build offline and mobile web artifacts;
5. validate generated artifacts and source/output consistency;
6. run Capacitor synchronization;
7. run Android unit tests and lint;
8. build the APK;
9. verify signing identity and `debuggable` state;
10. publish only after all required gates pass.

The workflow never force-updates a published tag. An existing version tag or release causes a failure and requires a version increment.

Until protected production signing secrets are configured, APKs are published only as prerelease test builds with explicit debug/test labeling. Stable Android releases require a release variant, a protected signing key, certificate verification, and `debuggable=false`.

Generated files are not committed before builds and tests pass. If generated artifacts remain versioned, the workflow either verifies them without mutation or commits them only after the complete validation pipeline succeeds.

Third-party GitHub Actions are pinned to reviewed commit SHAs. Build, Pages deployment, and release jobs receive separate minimal permissions.

## Compatibility Changes

The remediation intentionally changes the following behavior:

- active or dangerous ebook markup no longer functions;
- uncommon EPUB content that depends on forms, frames, executable SVG, external active resources, or unsafe CSS is removed;
- offline fonts may differ from the online build, while functional features remain available;
- `npm start` is not reachable from other LAN devices unless explicitly configured;
- native callers cannot export arbitrary file paths;
- existing version tags cannot be replaced;
- APKs remain prereleases until production signing is configured.

No compatibility shim preserves unsafe path-based APIs or unsanitized rendering.

## Test Matrix

### Web and parser tests

- sanitize event attributes, scripts, dangerous URL schemes, forms, embeds, SVG execution, and dangerous CSS in EPUB, FB2, MOBI/AZW3, Markdown, metadata, and AI output;
- retain common formatting, tables, internal links, images, and safe static SVG;
- ensure parsing failures render escaped errors rather than raw input;
- verify AI links and images use approved schemes and safe link attributes;
- verify malicious metadata and folder names cannot inject markup.

### Persistence tests

- concurrent progress and statistics updates both persist;
- concurrent note, bookmark, AI chat, and summary updates do not overwrite each other;
- replacement clears content-derived summaries and indexes;
- restore follows explicit file/progress precedence and merges annotations by ID;
- transaction abort leaves existing state intact and reports failure.

### Async and resource tests

- stopped or superseded TTS sessions cannot start audio or update highlights;
- stale chapter loads and comic loads cannot render or save progress to another book;
- stale AI responses save only to their captured book and do not render in a new book;
- TTS timeout and cancellation close sockets and release bookkeeping once;
- chapter, page, cancelled-open, and close-book operations revoke their owned object URLs.

### Server tests

- raw and percent-encoded traversal paths cannot escape their allowed mount;
- root files and `.git` data are not exposed through an allowed prefix;
- default bind address is loopback;
- invalid Origin, oversized payload, excess queue data, excess connections, and idle sessions are rejected;
- explicitly configured valid clients can still use the TTS relay.

### Android tests

- approved cache/files inputs and granted content URIs work;
- absolute paths, traversal, unapproved file URIs, and symlink escapes fail with stable codes;
- ZIP sources and outputs cannot escape approved roots;
- the instrumentation test asserts the actual package name;
- notification permission branches and media service ordering are covered;
- stale native media events cannot target a destroyed plugin session;
- APK inspection verifies signing and debuggability appropriate to prerelease or stable mode.

### Artifact and CI tests

- the offline HTML has no external functional script dependency;
- the offline HTML works when copied alone and run without network access;
- every mobile local resource reference resolves in the mobile output;
- service worker cache ownership, precache completeness, fetch lifetime, and bounded runtime caching are tested for web deployment;
- workflow path filters include all deploy inputs;
- CI runs tests before publication and does not rewrite existing releases.

## Verification Gate

The exact commands may be adjusted for the upgraded toolchain, but the final clean-checkout gate must include the equivalent of:

```sh
npm ci
npm test
npm audit --audit-level=high
npm run build:offline
npm run build:mobile
npm run test:artifacts
cd android
./gradlew test lint assembleDebug
```

An emulator-backed job runs instrumentation tests and blocks stable release. Security regression tests must also rerun the original static traversal request and malicious-book fixtures.

## Completion Criteria

Each audit finding receives a tracked disposition with a regression test or documented validation evidence. The remediation is complete only when:

- executable imported content cannot cross into the application trust domain;
- server and native file boundaries resist traversal and arbitrary reads;
- concurrent storage and stale asynchronous operations cannot corrupt another book or playback session;
- resources and network operations are bounded and cancellable;
- offline and mobile artifacts contain the resources they advertise;
- dependencies are locked and no unexcepted high or critical advisory remains;
- CI validates before publishing, never rewrites published tags, and labels unsigned test APKs as prereleases;
- the full clean-checkout verification gate passes.
