# TTS Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix incorrect TTS language grouping, mixed-content language detection, and Edge-only filtering.

**Architecture:** Keep the source logic in `reader/reader.js`, add small pure helpers for testable decisions, and regenerate the two bundled HTML outputs from the source. The selector will render each voice once from a single filtered list.

**Tech Stack:** Browser JavaScript, Node.js regression script, existing offline compiler.

---

### Task 1: Add regression coverage

**Files:**
- Modify: `scratch/test_tts_review_fixes.js`
- Modify: `package.json`

- [x] **Step 1: Write the failing test**

The test imports the source helper functions by extraction and asserts unmatched-language grouping, strict Edge-only filtering, and body-first chapter-title behavior.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL because `getTTSVoiceGroups` is not yet defined.

### Task 2: Implement pure TTS decisions

**Files:**
- Modify: `reader/reader.js`

- [x] **Step 1: Add `shouldAppendChapterTitles(contentSample, chapterTitles)`**

Return true only when the body sample is empty and chapter titles contain text.

- [x] **Step 2: Add `getTTSVoiceGroups(voices, lang, edgeOnly)`

Filter Edge voices first when requested, identify only true language matches as recommended, and place all remaining available voices in the other group. If there is no target-language match, keep the recommended group empty.

- [x] **Step 3: Use the helpers in detection and selector rendering**

Use the chapter-title helper in `detectBookLanguage`, and use the voice-group helper in `initTTSPanelVoices` so each voice is rendered once and strict Edge-only filtering applies.

- [x] **Step 4: Run the regression test**

Run: `npm test`
Expected: PASS.

### Task 3: Regenerate and verify distribution files

**Files:**
- Modify: `index.html`
- Modify: `reader_offline.html`

- [x] **Step 1: Rebuild bundled files**

Run: `npm run build:offline`
Expected: successful compilation of both HTML files.

- [x] **Step 2: Run syntax and diff checks**

Run: `node --check server.js && node --check service-worker.js`
Run: `git diff --check`
Expected: both commands exit successfully.

- [x] **Step 3: Run the complete test command**

Run: `npm test`
Expected: PASS with `TTS review regression tests passed`.
