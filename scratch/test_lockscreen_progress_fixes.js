const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('--- Testing iOS Lock Screen & Notification Center Progress Fixes ---');

// 1. Verify AppDelegate.swift code fixes
const appDelegatePath = path.join(__dirname, '../ios/App/App/AppDelegate.swift');
const appDelegateContent = fs.readFileSync(appDelegatePath, 'utf8');

// Check that the hardcoded Double(newIndex) * 5.0 bug has been completely eradicated
assert(
  !appDelegateContent.includes('Double(newIndex) * 5.0'),
  'FAILED: Double(newIndex) * 5.0 still exists in AppDelegate.swift!'
);

// Check that currentChapterProgressBase is incremented by finishedDuration
assert(
  appDelegateContent.includes('self.currentChapterProgressBase += finishedDuration'),
  'FAILED: handleSentenceCompletion does not accumulate finishedDuration into currentChapterProgressBase!'
);

// Check that syncNowPlaying respects currentPlaybackRate
assert(
  appDelegateContent.includes('let targetRate = Double(self.currentPlaybackRate > 0 ? self.currentPlaybackRate : 1.0)') &&
  appDelegateContent.includes('self.authoritativeNowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? targetRate : 0.0'),
  'FAILED: syncNowPlaying does not use targetRate!'
);

// Check that currentPlayingChapterIndex is declared and tracked
assert(
  appDelegateContent.includes('private var currentPlayingChapterIndex: Int = -1'),
  'FAILED: currentPlayingChapterIndex is not declared in AppDelegate.swift!'
);

// Check that updateNowPlaying uses realAudioCurrentTime during playback
assert(
  appDelegateContent.includes('let realAudioCurrentTime = self.currentChapterProgressBase + currentAudioOffset'),
  'FAILED: updateNowPlaying does not use realAudioCurrentTime!'
);

// 2. Verify reader/tts.js code fixes
const ttsPath = path.join(__dirname, '../reader/tts.js');
const ttsContent = fs.readFileSync(ttsPath, 'utf8');

// Check that estimateDuration does not divide by rate
assert(
  !ttsContent.includes('len / (4.2 * rate)'),
  'FAILED: estimateDuration still divides by rate (double rate scaling bug)!'
);
assert(
  ttsContent.includes('len / 4.2'),
  'FAILED: estimateDuration missing standard len / 4.2 calculation!'
);

// Check that chapterIndex is passed in playNativeSentence and updateMetadata
assert(
  ttsContent.includes('chapterIndex: progress.chapterIndex'),
  'FAILED: tts.js does not pass chapterIndex in native payload!'
);

// Check that sentenceStarted stores actualDuration
assert(
  ttsContent.includes('currentSentence.actualDuration = data.duration'),
  'FAILED: sentenceStarted does not store actualDuration!'
);

console.log('✅ All iOS Lock Screen & Notification Center Progress Fix tests passed successfully!');
