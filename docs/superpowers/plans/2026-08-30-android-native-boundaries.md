# Android Native Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict native file and ZIP capabilities, make media callbacks lifecycle-safe, and support current Android storage, notification, and foreground-service rules.

**Architecture:** Extract pure Java path/ZIP policy helpers with local unit tests, then make the Capacitor plugin consume only controlled app-owned or granted content URIs. Replace static plugin ownership with session-aware registration and use SAF for user-selected exports.

**Tech Stack:** Java, Capacitor 8, Android SAF/MediaStore, JUnit, Android instrumentation tests.

---

### Task 1: Add native boundary helpers and red tests

**Files:**
- Create: `android/app/src/main/java/com/edgereader/app/NativeFileBoundary.java`
- Create: `android/app/src/test/java/com/edgereader/app/NativeFileBoundaryTest.java`

- [ ] **Step 1: Write tests for containment and filenames**

```java
@Test public void rejectsSiblingPrefixEscape() throws Exception {
  File root = temporaryFolder.newFolder("cache");
  File sibling = temporaryFolder.newFolder("cache-other");
  assertFalse(NativeFileBoundary.isWithin(root, sibling));
}

@Test public void rejectsPathLikeFilename() {
  assertFalse(NativeFileBoundary.isSafeFilename("../backup.zip"));
  assertFalse(NativeFileBoundary.isSafeFilename("dir/backup.zip"));
  assertTrue(NativeFileBoundary.isSafeFilename("backup.zip"));
}
```

- [ ] **Step 2: Run and verify compilation failure**

Run: `cd android && ./gradlew testDebugUnitTest --tests com.edgereader.app.NativeFileBoundaryTest`

Expected: FAIL because `NativeFileBoundary` does not exist.

- [ ] **Step 3: Implement canonical separator-safe containment**

```java
static boolean isWithin(File root, File candidate) throws IOException {
  Path rootPath = root.getCanonicalFile().toPath();
  Path candidatePath = candidate.getCanonicalFile().toPath();
  return candidatePath.startsWith(rootPath);
}

static boolean isSafeFilename(String value) {
  return value != null && !value.isBlank() &&
      value.indexOf('/') < 0 && value.indexOf('\\') < 0 &&
      !value.equals(".") && !value.equals("..") && value.indexOf('\0') < 0;
}
```

- [ ] **Step 4: Run and commit**

Run: `cd android && ./gradlew testDebugUnitTest --tests com.edgereader.app.NativeFileBoundaryTest`

Expected: PASS.

```sh
git add android/app/src/main/java/com/edgereader/app/NativeFileBoundary.java android/app/src/test/java/com/edgereader/app/NativeFileBoundaryTest.java
git commit -m "test: define native file capability boundary"
```

### Task 2: Restrict export sources and use stable errors

**Files:**
- Modify: `android/app/src/main/java/com/edgereader/app/NativeTTS.java:246-389`
- Create: `android/app/src/main/java/com/edgereader/app/NativeError.java`
- Modify: `reader/reader.js:9510-9849`
- Test: `android/app/src/test/java/com/edgereader/app/NativeFileBoundaryTest.java`

- [ ] **Step 1: Add URI-scheme and root tests**

Cover app cache/files success; arbitrary file URI, absolute external path, traversal, unsupported scheme, unsafe filename, inaccessible content URI, and private-path-free error responses.

- [ ] **Step 2: Define stable error codes**

```java
enum NativeError {
  INVALID_SOURCE_URI, SOURCE_NOT_ALLOWED, SOURCE_NOT_FOUND,
  INVALID_FILENAME, DESTINATION_UNAVAILABLE, COPY_FAILED, USER_CANCELLED
}
```

- [ ] **Step 3: Replace generic source opening**

Only open `content://` through `ContentResolver` or app-owned canonical files under `getCacheDir()`/`getFilesDir()`. Reject every other source. Validate display names as basenames and never include private paths or raw exception messages in plugin rejection text.

- [ ] **Step 4: Update JavaScript callers**

Pass controlled URI values returned by Capacitor Filesystem/plugin staging, branch on stable native error codes, and treat `USER_CANCELLED` as a non-error without regex matching message text.

- [ ] **Step 5: Run and commit**

Run: `cd android && ./gradlew testDebugUnitTest`

Expected: PASS.

```sh
git add android/app/src/main/java/com/edgereader/app/NativeTTS.java android/app/src/main/java/com/edgereader/app/NativeError.java reader/reader.js android/app/src/test
git commit -m "fix: restrict native export sources"
```

### Task 3: Harden ZIP creation

**Files:**
- Create: `android/app/src/main/java/com/edgereader/app/SafeZipWriter.java`
- Modify: `android/app/src/main/java/com/edgereader/app/NativeTTS.java:401-454`
- Create: `android/app/src/test/java/com/edgereader/app/SafeZipWriterTest.java`

- [ ] **Step 1: Add traversal, symlink, output recursion, and resource-bound tests**

Test normal nested files plus source/output `..`, absolute paths, symlink file/directory escape, output inside source, maximum entry count, depth, and byte limit.

- [ ] **Step 2: Implement checked recursion**

```java
if (Files.isSymbolicLink(child.toPath())) throw new SecurityException("SYMLINK_NOT_ALLOWED");
if (!child.getCanonicalFile().toPath().startsWith(rootPath))
  throw new SecurityException("SOURCE_NOT_ALLOWED");
String entryName = rootPath.relativize(child.toPath()).toString().replace(File.separatorChar, '/');
if (entryName.startsWith("../") || entryName.startsWith("/"))
  throw new SecurityException("INVALID_ZIP_ENTRY");
```

Use fixed maximum depth, entry count, and total input bytes; exclude the output file; close each ZIP entry in `finally`.

- [ ] **Step 3: Make the plugin accept a fixed staging directory ID and safe output basename**

Return a controlled shareable URI rather than `Uri.fromFile()` to arbitrary caller-controlled output.

- [ ] **Step 4: Run and commit**

Run: `cd android && ./gradlew testDebugUnitTest --tests com.edgereader.app.SafeZipWriterTest`

Expected: PASS.

```sh
git add android/app/src/main/java/com/edgereader/app android/app/src/test/java/com/edgereader/app/SafeZipWriterTest.java
git commit -m "fix: constrain native ZIP creation"
```

### Task 4: Use SAF consistently and narrow FileProvider exposure

**Files:**
- Modify: `android/app/src/main/java/com/edgereader/app/NativeTTS.java:246-389`
- Modify: `android/app/src/main/res/xml/file_paths.xml`
- Create: `android/app/src/androidTest/java/com/edgereader/app/FileExportInstrumentedTest.java`

- [ ] **Step 1: Add instrumentation coverage for picker success/cancel and repeated requests**

Assert API 23-28 follows `ACTION_CREATE_DOCUMENT`, picker destinations receive correct bytes, cancellation returns `USER_CANCELLED`, and a second request cannot overwrite the first request's source state.

- [ ] **Step 2: Replace global pending URI with a per-call operation**

Keep validated source ownership with the Capacitor activity result call, clear operation state on every success/failure/cancel/reset path, and use the picker URI as the only destination on legacy Android.

- [ ] **Step 3: Remove broad external provider paths**

Retain only required app cache/files entries in `file_paths.xml`; remove `<external-path path="." />`.

- [ ] **Step 4: Run and commit**

Run: `cd android && ./gradlew connectedDebugAndroidTest`

Expected: PASS on an available emulator; if no emulator exists locally, CI remains the required gate and the local run must report that limitation.

```sh
git add android/app/src/main/java/com/edgereader/app/NativeTTS.java android/app/src/main/res/xml/file_paths.xml android/app/src/androidTest
git commit -m "fix: use controlled SAF export flows"
```

### Task 5: Make media service ownership session-aware

**Files:**
- Modify: `android/app/src/main/java/com/edgereader/app/NativeTTS.java:42-123`
- Modify: `android/app/src/main/java/com/edgereader/app/AudioPlayerService.java`
- Modify: `reader/tts.js`
- Create: `android/app/src/test/java/com/edgereader/app/PlaybackSessionRegistryTest.java`

- [ ] **Step 1: Add stale-session tests**

Test activity/plugin recreation, old service action after a new session starts, repeated stop/destroy, and absent plugin receiver. Old events must be dropped.

- [ ] **Step 2: Replace the static strong plugin singleton**

Introduce an application-scoped registry holding a weak current receiver plus session ID. Every start/update/stop intent and media callback includes that ID; delivery requires an exact current match. Plugin reset/destroy unregisters the receiver.

- [ ] **Step 3: Register and remove JavaScript listener handles**

Capture the Capacitor listener handle in `tts.js`, remove it on session teardown, and ignore native events whose session ID differs from the active TTS generation.

- [ ] **Step 4: Run and commit**

Run: `cd android && ./gradlew testDebugUnitTest --tests com.edgereader.app.PlaybackSessionRegistryTest`

Expected: PASS.

```sh
git add android/app/src/main/java/com/edgereader/app reader/tts.js android/app/src/test/java/com/edgereader/app/PlaybackSessionRegistryTest.java
git commit -m "fix: bind media controls to active native sessions"
```

### Task 6: Handle notification permission and foreground-service ordering

**Files:**
- Modify: `android/app/src/main/AndroidManifest.xml`
- Modify: `android/app/src/main/java/com/edgereader/app/MainActivity.java`
- Modify: `android/app/src/main/java/com/edgereader/app/NativeTTS.java`
- Modify: `android/app/src/main/java/com/edgereader/app/AudioPlayerService.java`
- Create: `android/app/src/androidTest/java/com/edgereader/app/NotificationInstrumentedTest.java`

- [ ] **Step 1: Add granted/denied service-flow tests**

Cover Android 13+ permission branches, repeated starts, update-before-start, stop/update race, and service recreation. Denial must produce a stable degraded status rather than a stuck call.

- [ ] **Step 2: Declare and request permission from a user-driven flow**

Add `POST_NOTIFICATIONS`; expose a plugin method that reports/request status. Do not repeatedly prompt on playback. Return whether lock-screen controls are available.

- [ ] **Step 3: Serialize service state**

Start through the foreground-service path before updates, call `startForeground` promptly in `onStartCommand`, retain desired state for recreation, and ignore updates/stops from stale sessions.

- [ ] **Step 4: Run and commit**

Run: `cd android && ./gradlew connectedDebugAndroidTest`

Expected: PASS on emulator API 33+.

```sh
git add android/app/src/main/AndroidManifest.xml android/app/src/main/java/com/edgereader/app android/app/src/androidTest
git commit -m "fix: support notification and foreground service policy"
```

### Task 7: Correct Android identity tests and validate native build

**Files:**
- Move: `android/app/src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java` to `android/app/src/androidTest/java/com/edgereader/app/AppIdentityInstrumentedTest.java`
- Delete: `android/app/src/test/java/com/getcapacitor/myapp/ExampleUnitTest.java`

- [ ] **Step 1: Assert the real application ID**

```java
assertEquals("com.edgereader.app", appContext.getPackageName());
```

- [ ] **Step 2: Run native verification**

Run: `cd android && ./gradlew test lint assembleDebug`

Expected: BUILD SUCCESSFUL with all local unit tests passing and no fatal lint errors.

- [ ] **Step 3: Commit**

```sh
git add android/app/src/test android/app/src/androidTest
git commit -m "test: replace Android template coverage"
```
