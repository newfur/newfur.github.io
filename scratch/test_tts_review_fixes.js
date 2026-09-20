const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('reader/reader.js', 'utf8');

function extractFunction(name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${name}`);
  let depth = 0;
  let opened = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
      opened = true;
    } else if (source[i] === '}') {
      depth--;
      if (opened && depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Could not extract ${name}`);
}

const getTTSVoiceGroups = eval(`(${extractFunction('getTTSVoiceGroups')})`);
const shouldAppendChapterTitles = eval(`(${extractFunction('shouldAppendChapterTitles')})`);

const voices = [
  { name: 'English Edge', lang: 'en-US', isEdge: true },
  { name: 'English System', lang: 'en-US', isEdge: false },
  { name: 'Chinese Edge', lang: 'zh-CN', isEdge: true }
];

// Unmatched language: matchedVoices should be empty, all voices in availableVoices
{
  const result = getTTSVoiceGroups(voices, 'pt', false);
  assert.deepStrictEqual(result.matchedVoices, [], 'unmatched language should have empty matchedVoices');
  assert.deepStrictEqual(result.availableVoices, voices, 'all voices should remain available');
}

// Edge-only mode filters non-Edge voices
{
  const result = getTTSVoiceGroups(voices, 'pt', true);
  assert.deepStrictEqual(result.matchedVoices, [], 'unmatched + Edge-only: no matched voices');
  assert.deepStrictEqual(result.availableVoices, [voices[0], voices[2]], 'Edge-only should keep only Edge voices');
}

// Matched language returns only matching voices
{
  const result = getTTSVoiceGroups(voices, 'en', false);
  assert.strictEqual(result.matchedVoices.length, 2, 'en should match 2 English voices');
  assert.ok(result.matchedVoices.every(v => v.lang.startsWith('en')), 'all matched should be English');
}

// shouldAppendChapterTitles
assert.strictEqual(shouldAppendChapterTitles('body text', 'chapter title'), false);
assert.strictEqual(shouldAppendChapterTitles('', 'chapter title'), true);

// Exact locale and high-quality ordering
const localeVoices = [
  { name: 'Simplified Chinese', lang: 'zh-CN', isEdge: true },
  { name: 'Traditional Chinese', lang: 'zh-TW', isEdge: true },
  { name: 'Apple Taiwan', lang: 'zh-TW', isEdge: false },
  { name: 'Microsoft HsiaoChen Neural', lang: 'zh-TW', isEdge: true }
];
assert.deepStrictEqual(
  getTTSVoiceGroups(localeVoices, 'zh-TW', false).matchedVoices.map(voice => voice.name),
  ['Microsoft HsiaoChen Neural', 'Traditional Chinese', 'Apple Taiwan', 'Simplified Chinese'],
  'exact locale and high-quality voices should be preferred within a language group'
);

// Custom provider voices must not bypass Edge-only mode
assert.match(
  source,
  /ttsDefaultVoice && !hasDefaultVoice && !ttsOnlyEdge/,
  'custom provider voices must not bypass Edge-only mode'
);

// Global language setting should be a fallback, not override
assert.doesNotMatch(
  source.split('function detectBookLanguage')[1].split('\n').slice(0, 5).join('\n'),
  /currentTTSLanguage/,
  'detectBookLanguage must not use global language as first priority'
);

// Interjection short sentence detection
const ttsSource = fs.readFileSync('reader/tts.js', 'utf8');
function extractFunctionFromTTS(name) {
  const marker = `function ${name}`;
  const start = ttsSource.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${name}`);
  let depth = 0;
  let opened = false;
  for (let i = ttsSource.indexOf('{', start); i < ttsSource.length; i++) {
    if (ttsSource[i] === '{') {
      depth++;
      opened = true;
    } else if (ttsSource[i] === '}') {
      depth--;
      if (opened && depth === 0) {
        return ttsSource.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Could not extract ${name}`);
}

const isInterjectionShortSentence = eval(`(${extractFunctionFromTTS('isInterjectionShortSentence')})`);
assert.strictEqual(isInterjectionShortSentence('“嗯。”'), true, '“嗯。” should be an interjection');
assert.strictEqual(isInterjectionShortSentence('“啊！”'), true, '“啊！” should be an interjection');
assert.strictEqual(isInterjectionShortSentence('“哦……”'), true, '“哦……” should be an interjection');
assert.strictEqual(isInterjectionShortSentence('“哎呀！”'), true, '“哎呀！” should be an interjection');
assert.strictEqual(isInterjectionShortSentence('“走！”'), false, '“走！” is not an interjection');
assert.strictEqual(isInterjectionShortSentence('“他死了。”'), false, '“他死了。” is not an interjection');
assert.strictEqual(isInterjectionShortSentence('“第三章”'), false, '“第三章” is not an interjection');

// Test complete sentence splitting (never split at commas or colons)
const splitTextIntoSentences = eval(`(${extractFunctionFromTTS('splitTextIntoSentences')})`);
const longWithCommas = '从拂晓开始，天空中就布满了阴沉沉的铅灰色云层，风夹杂着刺骨的寒意掠过荒原，远处的树木在风中剧烈地摇晃，仿佛在向无边的荒野诉说着即将来临的暴风雨，而我们一行人只能顶着狂风艰难前行，每迈出一步都需要耗费巨大的力气，甚至连呼吸都变得困难起来。';
const splitResult = splitTextIntoSentences(longWithCommas);
assert.strictEqual(splitResult.length, 1, 'sentence with commas must NOT be split at commas');
assert.strictEqual(splitResult[0], longWithCommas, 'entire grammatical sentence must be preserved as one complete sentence');

// Pause watchdog and silence keepalive guards
assert.match(
  ttsSource,
  /if \(!this\.isPlaying \|\| this\.isPaused\) return; \/\/ 暫停或未播放時嚴禁啟動靜音音訊/,
  '_startSilenceKeepAlive must have strict pause/play guard'
);
assert.match(
  ttsSource,
  /if \(!this\.isPlaying \|\| this\.isPaused\) return; \/\/ 處於暫停或停止狀態時絕不啟動看門狗/,
  '_startPlaybackWatchdog must have strict pause/play guard'
);
assert.match(
  ttsSource,
  /this\.isPaused = true;\s+this\._stopPlaybackWatchdog\(\);\s+this\._stopSilenceKeepAlive\(\);/,
  'pause() must unconditionally set isPaused and stop watchdog and silence keep-alive'
);

// Chapter progress calculation and prefetch throttling regression checks
assert.match(
  ttsSource,
  /_getChapterProgress\(sentence\)/,
  'tts.js must define _getChapterProgress to compute duration scoped to current chapter'
);
assert.match(
  ttsSource,
  /_updatePositionState\(forcedPosition = null\)/,
  'tts.js must define _updatePositionState to continuously update mediaSession position'
);
assert.match(
  ttsSource,
  /actualDuration/,
  'tts.js must support actualDuration tracking for seamless chapter timeline'
);
assert.match(
  ttsSource,
  /const remainingSentences = this\.sentences\.length - this\.currentIndex;\s+if \(remainingSentences > 20\) \{\s+return;\s+\}/,
  '_prefetchNextChapter must throttle prefetching when remainingSentences > 20'
);

// Chapter progress simulation test
class MockTTSEngine {
  constructor() {
    this.currentIndex = 0;
    this.rate = 1.0;
    this.currentChapterIndex = 0;
    this.isPlaying = true;
    this.isPaused = false;
    this.sentences = [
      { index: 0, chapterIndex: 0, text: '第一句话。' },
      { index: 1, chapterIndex: 0, text: '第二句比较长的一句话测试。' },
      { index: 2, chapterIndex: 0, text: '第三句。' },
      { index: 3, chapterIndex: 1, text: '第二章第一句。' }
    ];
    this.epubBookData = {
      chapters: [
        { index: 0, cleanHref: 'chapter1.html', title: '第一章' },
        { index: 1, cleanHref: 'chapter2.html', title: '第二章' }
      ]
    };
    this.currentAudio = {
      currentTime: 0,
      duration: 0
    };
    this.mediaSessionState = null;
  }

  _getChapterProgress(sentence) {
    const currentSentence = sentence || (this.sentences && this.sentences[this.currentIndex]) || null;
    const currentChapterIdx = (currentSentence && currentSentence.chapterIndex !== undefined && currentSentence.chapterIndex !== null)
      ? currentSentence.chapterIndex
      : (this.currentChapterIndex !== undefined ? this.currentChapterIndex : 0);

    const sameFileIndices = new Set();
    sameFileIndices.add(currentChapterIdx);
    if (this.epubBookData && this.epubBookData.chapters) {
      const currentChapter = this.epubBookData.chapters[currentChapterIdx];
      if (currentChapter && currentChapter.cleanHref) {
        this.epubBookData.chapters.forEach((ch, idx) => {
          if (ch.cleanHref === currentChapter.cleanHref) {
            sameFileIndices.add(idx);
          }
        });
      }
    }

    let chapterSentences = [];
    if (Array.isArray(this.sentences)) {
      chapterSentences = this.sentences.filter(s => sameFileIndices.has(s.chapterIndex));
    }
    if (chapterSentences.length === 0) {
      chapterSentences = this.sentences || [];
    }

    const totalSentences = Math.max(1, chapterSentences.length);

    let sentIdxInChapter = 0;
    if (currentSentence) {
      sentIdxInChapter = chapterSentences.indexOf(currentSentence);
      if (sentIdxInChapter < 0) {
        sentIdxInChapter = chapterSentences.findIndex(s => s.index === currentSentence.index);
      }
    }
    if (sentIdxInChapter < 0) {
      sentIdxInChapter = 0;
    }
    sentIdxInChapter = Math.max(0, Math.min(sentIdxInChapter, totalSentences - 1));

    const rate = (typeof this.rate === 'number' && this.rate > 0) ? this.rate : 1.0;
    const estimateDuration = (s) => {
      if (s && typeof s.actualDuration === 'number' && s.actualDuration > 0) {
        return s.actualDuration;
      }
      const len = (s && s.text) ? s.text.length : 15;
      return Math.max(1.5, (len / (4.2 * rate)) + 0.5);
    };

    let elapsedSeconds = 0;
    for (let i = 0; i < sentIdxInChapter; i++) {
      elapsedSeconds += estimateDuration(chapterSentences[i]);
    }

    let totalDuration = 0;
    for (let i = 0; i < chapterSentences.length; i++) {
      totalDuration += estimateDuration(chapterSentences[i]);
    }
    totalDuration = Math.max(60.0, totalDuration);
    elapsedSeconds = Math.min(elapsedSeconds, totalDuration);

    return {
      chapterIndex: currentChapterIdx,
      chapterSentences: chapterSentences,
      sentIdxInChapter: sentIdxInChapter,
      totalSentences: totalSentences,
      duration: totalDuration,
      position: elapsedSeconds
    };
  }

  _updatePositionState(forcedPosition = null) {
    const progress = this._getChapterProgress();
    const chapterDuration = progress.duration;
    if (!chapterDuration || chapterDuration <= 0 || isNaN(chapterDuration)) return;

    let currentElapsed;
    if (typeof forcedPosition === 'number' && !isNaN(forcedPosition)) {
      currentElapsed = forcedPosition;
    } else {
      const audio = this.currentAudio;
      const sentenceCurrentTime = (audio && typeof audio.currentTime === 'number' && !isNaN(audio.currentTime)) ? audio.currentTime : 0;
      currentElapsed = progress.position + sentenceCurrentTime;
    }

    const safeDuration = Math.max(60.0, Number(chapterDuration) || 60.0);
    const safePosition = Math.max(0, Math.min(Number(currentElapsed) || 0, safeDuration));
    const safeRate = Math.max(0.1, Number(this.rate) || 1.0);

    this.mediaSessionState = {
      duration: safeDuration,
      playbackRate: safeRate,
      position: safePosition
    };
  }
}

{
  const simEngine = new MockTTSEngine();
  // Sentence 0 start
  simEngine.currentIndex = 0;
  simEngine.currentAudio.currentTime = 0;
  simEngine._updatePositionState();
  assert.strictEqual(simEngine.mediaSessionState.position, 0);
  assert.strictEqual(simEngine.mediaSessionState.playbackRate, 1.0);
  assert.ok(simEngine.mediaSessionState.duration >= 60.0);

  // Sentence 0 playing (currentTime advances to 2.5s)
  simEngine.currentAudio.currentTime = 2.5;
  simEngine._updatePositionState();
  assert.strictEqual(simEngine.mediaSessionState.position, 2.5);

  // Sentence 0 finishes, actual duration recorded as 3.2s
  simEngine.sentences[0].actualDuration = 3.2;

  // Sentence 1 starts: position should seamlessly start at 3.2s
  simEngine.currentIndex = 1;
  simEngine.currentAudio.currentTime = 0;
  simEngine._updatePositionState();
  assert.strictEqual(simEngine.mediaSessionState.position, 3.2, 'Sentence 1 must start exactly where sentence 0 ended');

  // Sentence 1 plays for 1.8s: position advances to 5.0s
  simEngine.currentAudio.currentTime = 1.8;
  simEngine._updatePositionState();
  assert.strictEqual(Math.round(simEngine.mediaSessionState.position * 10) / 10, 5.0);

  // Sentence 1 finishes, actual duration recorded as 4.5s
  simEngine.sentences[1].actualDuration = 4.5;

  // Sentence 2 starts: position should seamlessly be 3.2 + 4.5 = 7.7s
  simEngine.currentIndex = 2;
  simEngine.currentAudio.currentTime = 0;
  simEngine._updatePositionState();
  assert.strictEqual(Math.round(simEngine.mediaSessionState.position * 10) / 10, 7.7);

  // Paused state: playbackRate must remain non-zero (> 0)
  simEngine.isPaused = true;
  simEngine._updatePositionState();
  assert.ok(simEngine.mediaSessionState.playbackRate >= 0.1, 'playbackRate must never be 0 in setPositionState');
}

// Option A: Single sentence progress and chapter percentage regression assertions
const updatedTtsSource = fs.readFileSync('reader/tts.js', 'utf8');
assert.match(
  updatedTtsSource,
  /navigator\.mediaSession\.metadata\.title = text;/,
  'tts.js must mutate metadata in-place to prevent MediaMetadata recreation flicker'
);
assert.match(
  updatedTtsSource,
  /this\._currentMediaSessionSentenceIndex === sentIndex/,
  'tts.js must deduplicate _updateMediaSession calls for the same sentence'
);
assert.match(
  updatedTtsSource,
  /this\._mediaSessionActionHandlersAttached/,
  'tts.js must only attach MediaSession action handlers once'
);
assert.match(
  updatedTtsSource,
  /this\._updatePositionState\(0\);\s+this\._updateMediaSession\(sentence\);/,
  'tts.js must pre-sync sentence zero start and metadata before changing audio.src'
);
assert.match(
  updatedTtsSource,
  /\$\{chapterTitle\} \(\$\{pct\}%\)/,
  'tts.js must display chapter progress percentage in subtitle'
);
assert.match(
  updatedTtsSource,
  /this\._initMediaSessionHandlers\(\);/,
  'tts.js must initialize MediaSession action handlers globally in constructor'
);
assert.match(
  updatedTtsSource,
  /_initMediaSessionHandlers\(\) \{/,
  'tts.js must define _initMediaSessionHandlers method'
);
assert.match(
  updatedTtsSource,
  /safeSet\('togglepause'/,
  'tts.js must register togglepause handler for bluetooth earphones'
);
assert.match(
  updatedTtsSource,
  /this\._isSwitchingSource = true;/,
  'tts.js must mark _isSwitchingSource when changing audio source'
);
assert.match(
  updatedTtsSource,
  /if \(this\._isSwitchingSource \|\| audio\.ended\)/,
  'tts.js must distinguish source transitions from hardware pause events'
);
assert.match(
  updatedTtsSource,
  /Hardware\/Bluetooth pause detected on active audio element, pausing TTS[\s\S]*?this\.pause\(\);/,
  'tts.js must invoke this.pause() when hardware/bluetooth pauses the audio element'
);
assert.match(
  updatedTtsSource,
  /Native\/Bluetooth triggered play while paused\/stopped, resuming[\s\S]*?this\.resume\(\);/,
  'tts.js must invoke this.resume() when hardware/bluetooth plays the audio element while paused'
);

// Font regression tests: All supported fonts must declare local() fallbacks for offline usage
const readerCssSource = fs.readFileSync('reader/reader.css', 'utf8');
const supportedFontFamilies = [
  'LXGW WenKai',
  'Noto Serif TC',
  'Lora',
  'Inter',
  'Playfair Display',
  'Fira Code',
  'OpenDyslexic'
];
for (const font of supportedFontFamilies) {
  assert.ok(
    readerCssSource.includes(`font-family: '${font}'`) && readerCssSource.includes(`local('${font}')`),
    `reader.css must declare local() fallback for ${font}`
  );
}

// Ensure offline build script makes font links non-blocking
const compileOfflineSource = fs.readFileSync('scratch/compile_offline.js', 'utf8');
assert.match(
  compileOfflineSource,
  /media="print" onload="this\.media/,
  'compile_offline.js must make external font links non-blocking'
);
assert.match(
  compileOfflineSource,
  /data:font\/woff2;base64/,
  'compile_offline.js must inline WOFF2 font as Base64 data URI into CSS @font-face'
);

// Verify reader.css declares woff2 URL fallback for LXGW WenKai
assert.match(
  readerCssSource,
  /url\('\.\/fonts\/lxgw-wenkai-screen-standard\.woff2'\)\s*format\('woff2'\)/,
  'reader.css must declare WOFF2 fallback url for LXGW WenKai'
);

// Verify font file existence and integrity
assert.ok(
  fs.existsSync('reader/fonts/lxgw-wenkai-screen-standard.woff2'),
  'reader/fonts/lxgw-wenkai-screen-standard.woff2 must exist'
);
const fontStat = fs.statSync('reader/fonts/lxgw-wenkai-screen-standard.woff2');
assert.ok(
  fontStat.size > 3500000 && fontStat.size < 4800000,
  `Embedded SC+TC font file size must be around 4MB, actual: ${fontStat.size}`
);
const fontBuffer = fs.readFileSync('reader/fonts/lxgw-wenkai-screen-standard.woff2');
assert.strictEqual(
  fontBuffer.subarray(0, 4).toString('ascii'),
  'wOF2',
  'Font file must be a valid WOFF2 font (wOF2 magic header)'
);

// Verify LXGW WenKai font-weight range covers bold/headings/highlight (100 900)
assert.match(
  readerCssSource,
  /font-family:\s*'LXGW WenKai'[\s\S]*?font-weight:\s*100\s+900;/,
  'reader.css must declare font-weight: 100 900 range for LXGW WenKai'
);

// Verify highlight and TTS sentence elements inherit font-family
assert.match(
  readerCssSource,
  /\.font-lxgw\s+\.reading-sentence[\s\S]*?font-family:\s*var\(--font-lxgw\)\s*!important;/,
  'reader.css must enforce font-family on .reading-sentence under .font-lxgw'
);

// Verify font-synthesis is enabled
assert.match(
  readerCssSource,
  /font-synthesis:\s*weight\s+style;/,
  'reader.css must enable font-synthesis: weight style'
);

// ==================== Book Deletion & Ghost Prevention Tests ====================
const librarySource = fs.readFileSync('reader/library.js', 'utf8');

// 1. Verify _deletedBookIds set exists in BookLibrary constructor
assert.match(
  librarySource,
  /this\._deletedBookIds\s*=\s*new Set\(\);/,
  'BookLibrary constructor must initialize _deletedBookIds set'
);

// 2. Verify deleteBook registers id into _deletedBookIds and queues in _progressQueue
assert.match(
  librarySource,
  /this\._deletedBookIds\.add\(String\(id\)\);/,
  'deleteBook must record id into _deletedBookIds'
);
assert.match(
  librarySource,
  /this\._progressQueue\s*=\s*this\._progressQueue\.then\(task,\s*task\);/,
  'deleteBook must be sequenced in _progressQueue to avoid concurrency race condition'
);

// 3. Verify _mutateBook checks _deletedBookIds and validates store.get before store.put
assert.match(
  librarySource,
  /if\s*\(!id\s*\|\|\s*this\._deletedBookIds\.has\(String\(id\)\)\)\s*\{\s*return null;\s*\}/,
  '_mutateBook must immediately reject deleted book IDs'
);
assert.match(
  librarySource,
  /const checkReq = store\.get\(id\);[\s\S]*?if\s*\(!checkReq\.result\s*\|\|\s*this\._deletedBookIds\.has\(String\(id\)\)\)/,
  '_mutateBook must perform intra-transaction safety check before executing store.put'
);

// 4. Verify getBook returns null when fileRecord is missing
assert.match(
  librarySource,
  /if\s*\(!fileRecord\s*\|\|\s*!fileRecord\.file\)\s*\{[\s\S]*?return null;/,
  'getBook must return null when physical file in book_files is missing'
);

// 5. Verify cleanOrphanedBooks method exists
assert.match(
  librarySource,
  /async\s+cleanOrphanedBooks\(\)/,
  'BookLibrary must provide cleanOrphanedBooks method'
);

// 6. Verify deleteBookHandler cleans pendingIndexedDBUpdates and localStorage
assert.match(
  source,
  /pendingIndexedDBUpdates\.delete\(id\);/,
  'deleteBookHandler must clean in-flight pendingIndexedDBUpdates'
);
assert.match(
  source,
  /localStorage\.removeItem\(`edgereader_progress_\$\{id\}`\);/,
  'deleteBookHandler must clean localStorage progress'
);
assert.match(
  source,
  /bookCoverCache\.delete\(id\);/,
  'deleteBookHandler must clean bookCoverCache'
);

// 7. Verify openBook auto-cleans orphaned books
assert.match(
  source,
  /\[openBook\] Auto-cleaning orphaned book metadata for ID:/,
  'openBook must detect and clean orphaned book metadata'
);

// 8. Verify locale message for missing file cleanup in all 3 locales
for (const loc of ['en', 'zh_CN', 'zh_TW']) {
  const locJson = JSON.parse(fs.readFileSync(`_locales/${loc}/messages.json`, 'utf8'));
  assert.ok(
    locJson.book_file_missing_cleaned && locJson.book_file_missing_cleaned.message,
    `_locales/${loc}/messages.json must contain book_file_missing_cleaned message`
  );
}

// 9. CSP Compliance & Anti-FOUC Regression Tests
const readerHtml = fs.readFileSync('reader/reader.html', 'utf8');
const themeInitPath = 'reader/theme-init.js';
assert.ok(fs.existsSync(themeInitPath), 'reader/theme-init.js must exist for CSP-compliant Anti-FOUC');

const themeInitContent = fs.readFileSync(themeInitPath, 'utf8');
assert.match(themeInitContent, /localStorage\.getItem\(['"]theme['"]\)/, 'theme-init.js must retrieve saved theme');
assert.match(themeInitContent, /document\.documentElement\.classList\.add/, 'theme-init.js must apply theme to documentElement');

// Check that reader.html has NO inline <script> tags without src
const scriptTags = readerHtml.match(/<script\b[^>]*>/gi) || [];
assert.ok(scriptTags.length > 0, 'reader.html must have scripts');
for (const tag of scriptTags) {
  assert.ok(/\bsrc=["'][^"']+["']/i.test(tag), `All script tags in reader.html must have src attribute: ${tag}`);
}
assert.match(readerHtml, /<script src="theme-init\.js"><\/script>/, 'reader.html must include external theme-init.js');

// Check that reader.html has NO inline event handlers
assert.ok(!/\bon[a-z]+=["']/i.test(readerHtml), 'reader.html must not contain inline event handlers');

// Check that reader.js has NO inline event handlers in template strings
assert.ok(!/\bon[a-z]+=["']/i.test(source), 'reader.js must not contain inline event handlers like onerror="..." in template strings');

// Check that reader.js registers global image error capturing listener
assert.match(source, /document\.addEventListener\('error'[\s\S]*?true\);/, 'reader.js must register capturing error listener');

console.log('TTS, font review, book deletion, and CSP compliance regression tests passed');





