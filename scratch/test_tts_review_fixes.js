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

assert.deepStrictEqual(
  getTTSVoiceGroups(voices, 'pt', false),
  {
    matchedVoices: [],
    otherVoices: voices,
    availableVoices: voices
  },
  'unmatched languages should use one non-recommended fallback group'
);

assert.deepStrictEqual(
  getTTSVoiceGroups(voices, 'pt', true),
  {
    matchedVoices: [],
    otherVoices: [voices[0], voices[2]],
    availableVoices: [voices[0], voices[2]]
  },
  'Edge-only mode should remove every non-Edge voice'
);

assert.strictEqual(shouldAppendChapterTitles('body text', 'chapter title'), false);
assert.strictEqual(shouldAppendChapterTitles('', 'chapter title'), true);

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

assert.match(
  source,
  /ttsDefaultVoice && !hasDefaultVoice && !ttsOnlyEdge/,
  'custom provider voices must not bypass Edge-only mode'
);

console.log('TTS review regression tests passed');
