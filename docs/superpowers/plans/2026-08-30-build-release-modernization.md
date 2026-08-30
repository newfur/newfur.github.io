# Build and Release Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade vulnerable dependencies, produce complete offline/mobile artifacts, and make CI validation and releases reproducible, least-privilege, prerelease-safe, and immutable.

**Architecture:** Move to a committed npm lockfile and Capacitor 8-compatible toolchain. Separate compilation, artifact validation, native synchronization, testing, deployment, and release into ordered gates that consume immutable artifacts.

**Tech Stack:** Node 22, npm lockfiles, Capacitor 8, Gradle/AGP, GitHub Actions, Playwright artifact tests.

---

### Task 1: Lock and upgrade the dependency graph

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`
- Add: `package-lock.json`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `README.zh-TW.md`

- [ ] **Step 1: Add Node and version consistency checks**

Set `engines.node` to `>=22.0.0`, remove `package-lock.json` from `.gitignore`, and add `scripts.check:versions` that compares `manifest.json`, `package.json`, `package-lock.json.version`, and `package-lock.json.packages[''].version` without modifying files.

Preserve root `"type": "commonjs"`. Browser/test ESM is scoped by `reader/package.json` and `test/package.json`, so existing `server.js` and `scratch/*.js` do not require a mass rename.

- [ ] **Step 2: Upgrade one compatible package set**

Run:

```sh
npm install --save @capacitor/core@8.5.0 @capacitor/filesystem@^8.1.3 @capacitor/share@^8.0.1 dompurify
npm install --save-dev @capacitor/android@8.5.0 @capacitor/cli@8.5.0 jsdom @playwright/test
```

Expected: lockfile regenerated with Capacitor 8 packages.

- [ ] **Step 3: Verify dependency closure**

Run:

```sh
npm ls @capacitor/core @capacitor/android @capacitor/cli @capacitor/filesystem @capacitor/share dompurify
npm audit --audit-level=high
git check-ignore package-lock.json
```

Expected: compatible 8.x packages, audit exit 0, and no ignore match.

- [ ] **Step 4: Update installation docs to `npm ci` and commit**

```sh
git add .gitignore package.json package-lock.json README.md README.en.md README.zh-TW.md
git commit -m "build: upgrade and lock application dependencies"
```

### Task 2: Upgrade and synchronize the Android toolchain

**Files:**
- Modify: `android/build.gradle`
- Modify: `android/variables.gradle`
- Modify: `android/gradle/wrapper/gradle-wrapper.properties`
- Regenerate: `android/capacitor.settings.gradle`
- Regenerate: `android/app/capacitor.build.gradle`
- Modify: `android/app/build.gradle`
- Verify: `capacitor.config.json`

- [ ] **Step 1: Capture origin invariants in a test**

Add an artifact assertion that `appId`, namespace, and application ID remain `com.edgereader.app`, and `server.androidScheme` remains `https`.

- [ ] **Step 2: Run Capacitor migration/sync under Node 22**

Run:

```sh
npx cap migrate
npx cap sync android
```

Inspect every generated Gradle change. Accept the Capacitor 8 template's compatible AGP, Gradle, SDK, AndroidX, and Java baseline without changing the app ID or WebView origin.

- [ ] **Step 3: Build the synchronized project**

Run: `cd android && ./gradlew tasks test lint assembleDebug`

Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```sh
git add capacitor.config.json android
git commit -m "build: migrate Android project to Capacitor 8"
```

### Task 3: Separate deterministic build stages

**Files:**
- Modify: `package.json`
- Modify: `scratch/compile_offline.js`
- Modify: `scratch/build_dist.js`
- Create: `test/artifacts/build-contract.test.js`

- [ ] **Step 1: Add failing tests for source mutation and stage boundaries**

Assert `build:offline` does not modify package metadata, `build:mobile` does not invoke Capacitor sync, and version mismatch exits nonzero.

- [ ] **Step 2: Define scripts**

```json
"build:offline": "node scratch/compile_offline.js",
"build:mobile": "node scratch/build_dist.js",
"sync:android": "npx cap sync android",
"test:artifacts": "node --test test/artifacts/*.test.js",
"audit": "npm audit --audit-level=high"
```

- [ ] **Step 3: Replace version rewriting with validation**

Read all four version locations and throw on mismatch. Do not write `package.json` or the lockfile from a build script.

- [ ] **Step 4: Run and commit**

Run: `node --test test/artifacts/build-contract.test.js`

Expected: PASS.

```sh
git add package.json scratch test/artifacts/build-contract.test.js
git commit -m "build: separate deterministic artifact stages"
```

### Task 4: Make the offline artifact functionally self-contained

**Files:**
- Modify: `scratch/compile_offline.js`
- Modify: `reader/reader.js:7534-7677,10544-10557`
- Modify: `reader/reader.html:10-14,943-949`
- Modify: `reader/reader.css`
- Modify: `index.html`
- Modify: `reader_offline.html`
- Create: `test/artifacts/offline.test.js`

- [ ] **Step 1: Add a failing external-resource test**

Parse generated HTML and fail on functional `<script src>`, external stylesheet, Mermaid sibling path, or CDN fallback. Copy only the HTML into a temporary directory and assert startup plus Mermaid rendering under blocked network.

- [ ] **Step 2: Inline functional dependencies**

Inline JSZip, Mind Elixir, Mermaid, DOMPurify, Mind Elixir CSS, reader CSS, locales, and application modules. Remove network font links from offline output and retain system font fallbacks.

- [ ] **Step 3: Disable runtime CDN/PWA loaders in offline mode**

Use an injected build mode such as `window.__RACONTEUR_RUNTIME__ = 'offline'`; do not append remote Mermaid/Mind Elixir assets or register a service worker in that mode.

- [ ] **Step 4: Build, test, and commit**

Run:

```sh
npm run build:offline
node --test test/artifacts/offline.test.js
```

Expected: PASS; `index.html` and `reader_offline.html` are identical and contain no external functional dependency.

```sh
git add scratch/compile_offline.js reader index.html reader_offline.html test/artifacts/offline.test.js
git commit -m "fix: make offline reader self-contained"
```

### Task 5: Produce a complete native web artifact

**Files:**
- Modify: `scratch/build_dist.js`
- Modify: `reader/reader.js:10544-10557`
- Create: `test/artifacts/mobile.test.js`

- [ ] **Step 1: Add missing-reference and native-PWA tests**

Parse every generated local `src`, `href`, and CSS `url()` and assert it resolves under `www`; reject path escapes, service-worker registration, PWA manifest references, and unexpected remote functional assets.

- [ ] **Step 2: Inject explicit runtime mode**

Set `window.__RACONTEUR_RUNTIME__ = 'native'` in mobile output and register PWA features only when mode is `web`. Build `www` without invoking sync and copy only resources actually referenced by native output.

- [ ] **Step 3: Build and test**

Run:

```sh
npm run build:mobile
node --test test/artifacts/mobile.test.js
npm run sync:android
```

Expected: PASS; all local references exist and native output has no service-worker registration.

- [ ] **Step 4: Commit**

```sh
git add scratch/build_dist.js reader/reader.js test/artifacts/mobile.test.js
git commit -m "fix: make mobile web artifact internally complete"
```

### Task 6: Validate PWA output and base paths

**Files:**
- Modify: `manifest.webmanifest`
- Modify: `sw.js`
- Modify: `reader/reader.js`
- Create: `test/artifacts/pwa.test.js`

- [ ] **Step 1: Add project-subpath and precache tests**

Serve the artifact beneath `/repository/`, assert start URL/icons/offline download resolve beneath that base, every precache entry exists, required precache failure rejects installation, and unrelated origin caches survive activation.

- [ ] **Step 2: Make URLs deployment-base-relative**

Use `./` paths in the manifest and derive service-worker/offline-download URLs from document base URL. Generate or validate the complete application-shell precache list from deploy output.

- [ ] **Step 3: Run and commit**

Run: `node --test test/artifacts/pwa.test.js`

Expected: PASS.

```sh
git add manifest.webmanifest sw.js reader/reader.js test/artifacts/pwa.test.js
git commit -m "fix: make PWA artifacts base-path safe"
```

### Task 7: Replace the release workflow with gated jobs

**Files:**
- Modify: `.github/workflows/build-mobile.yml`
- Modify: `.github/workflows/clean-artifacts.yml`
- Create: `test/artifacts/workflow-policy.test.js`

- [ ] **Step 1: Add policy tests**

Parse workflow YAML as text/structure and reject `npm install`, `git tag -f`, force push, release deletion, stable debug APK publication, pre-validation source push, mutable action tags, broad global write permissions, and missing deploy-input path filters.

- [ ] **Step 2: Split least-privilege jobs**

Create `validate`, `build-web`, `android-test-build`, emulator instrumentation, Pages deploy, and prerelease jobs. Validation runs `npm ci`, tests, audit, both builds, artifact tests, sync, Gradle test/lint/build before any deployment or release.

- [ ] **Step 3: Enforce prerelease and immutable versions**

Name APK `Raconteur-<version>-debug-test.apk`, set `prerelease: true`, document debug signing, and fail when the tag or release already exists. Remove all force/delete/recreate behavior.

- [ ] **Step 4: Pin actions and remove release cleanup**

Replace every `uses:` reference with a reviewed 40-character commit SHA and version comment. Remove release/tag deletion from `clean-artifacts.yml`; retain only workflow/artifact retention with `actions: write` and `contents: read`.

- [ ] **Step 5: Run and commit**

Run: `node --test test/artifacts/workflow-policy.test.js`

Expected: PASS.

```sh
git add .github/workflows test/artifacts/workflow-policy.test.js
git commit -m "ci: gate immutable prerelease publication"
```

### Task 8: Run the clean-checkout release gate

**Files:**
- Verify all changed files

- [ ] **Step 1: Install from the lockfile and run web gates**

```sh
npm ci
npm test
npm audit --audit-level=high
npm run build:offline
npm run build:mobile
npm run test:artifacts
npm run sync:android
```

Expected: every command exits 0.

- [ ] **Step 2: Run native gates**

```sh
cd android
./gradlew test lint assembleDebug
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Inspect the test APK**

```sh
apksigner verify --verbose --print-certs app/build/outputs/apk/debug/app-debug.apk
apkanalyzer manifest application-id app/build/outputs/apk/debug/app-debug.apk
apkanalyzer manifest debuggable app/build/outputs/apk/debug/app-debug.apk
```

Expected: valid debug/test signature, application ID `com.edgereader.app`, and debuggable status appropriate only for prerelease.

- [ ] **Step 4: Check generated-source consistency and workflow policy**

```sh
git diff --check
git status --short
node --test test/artifacts/workflow-policy.test.js
```

Expected: no formatting errors, only intended implementation changes, and workflow policy PASS.
