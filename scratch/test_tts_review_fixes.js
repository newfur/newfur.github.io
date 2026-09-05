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

console.log('TTS review regression tests passed');


