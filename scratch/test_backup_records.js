const assert = require('assert');
const fs = require('fs');

console.log('--- Running Lightweight Backup & Reading Records Tests ---');

// 1. Verify library.js cleanOrphanedBooks logic
const librarySource = fs.readFileSync('reader/library.js', 'utf8');

// Ensure cleanOrphanedBooks does NOT delete books from books store
assert.doesNotMatch(
  librarySource.split('async cleanOrphanedBooks()')[1].split('return orphaned')[0],
  /await this\.deleteBook\(id\)/,
  'cleanOrphanedBooks must NOT delete books from the books metadata store'
);

assert.match(
  librarySource,
  /delStore\.delete\(fId\)/,
  'cleanOrphanedBooks must only delete orphaned binary files from book_files'
);

// 2. Verify replaceBookContent preserves progress, stats, and notes
const replaceContentSection = librarySource.split('async replaceBookContent')[1].split('async updateBook')[0];
assert.match(
  replaceContentSection,
  /保留現有閱讀進度、閱讀統計與筆記，嚴禁強制歸零/,
  'replaceBookContent must preserve existing progress, stats, and notes'
);
assert.match(
  replaceContentSection,
  /if\s*\(!book\.progress\)/,
  'replaceBookContent must only initialize progress if not already present'
);

// 3. Verify _cleanBookForStorage guarantees stats structure
assert.match(
  librarySource,
  /totalTime:\s*Number\(clean\.stats\.totalTime\)\s*\|\|\s*0/,
  '_cleanBookForStorage must guarantee valid stats structure with totalTime'
);
assert.match(
  librarySource,
  /readingDays:\s*\(clean\.stats\.readingDays/,
  '_cleanBookForStorage must guarantee valid readingDays object'
);
assert.match(
  librarySource,
  /hourlyDist:\s*\(clean\.stats\.hourlyDist/,
  '_cleanBookForStorage must guarantee valid hourlyDist object'
);

// 4. Verify smart progress and stats merge in importBook
const importBookSection = librarySource.split('async importBook')[1].split('async deleteBook')[0];
assert.match(
  importBookSection,
  /existingPercent\s*===\s*0\s*&&\s*backupPercent\s*>\s*0/,
  'importBook must prioritize backup progress when existing progress is 0'
);
assert.match(
  importBookSection,
  /Math\.max\(daysSum,\s*legacyMax\)/,
  'importBook must calculate totalTime as maximum of reading days sum and legacy totalTime'
);

// 5. Verify reader.js backup flushing and stats preservation
const readerSource = fs.readFileSync('reader/reader.js', 'utf8');

// Ensure handleExportBackup flushes reading time and debounced progress
assert.match(
  readerSource,
  /await\s+saveReadingTime\(\);\s*await\s+flushDebouncedIndexedDBProgress\(\);/,
  'handleExportBackup must flush saveReadingTime and flushDebouncedIndexedDBProgress'
);

// Ensure promptAttachBookFile exists and openBook prompts user instead of auto-deleting
assert.match(
  readerSource,
  /async\s+function\s+promptAttachBookFile\(/,
  'reader.js must provide promptAttachBookFile'
);
assert.match(
  readerSource,
  /lightweight_book_file_prompt/,
  'openBook must prompt user to attach file when book has metadata'
);
assert.match(
  readerSource,
  /\[openBook\] Auto-cleaning orphaned book metadata for ID:/,
  'openBook must retain auto-cleaning log for corrupted/empty metadata'
);

// 6. Verify locale messages in en, zh_CN, zh_TW
for (const loc of ['en', 'zh_CN', 'zh_TW']) {
  const locJson = JSON.parse(fs.readFileSync(`_locales/${loc}/messages.json`, 'utf8'));
  assert.ok(locJson.lightweight_book_file_prompt, `Missing lightweight_book_file_prompt in ${loc}`);
  assert.ok(locJson.lightweight_book_file_prompt.message, `Missing message in lightweight_book_file_prompt in ${loc}`);
  assert.ok(locJson.backup_mode_light_desc, `Missing backup_mode_light_desc in ${loc}`);
  assert.ok(locJson.backup_mode_light_desc.message.length > 10, `backup_mode_light_desc message too short in ${loc}`);
}

// 7. Verify package.json and manifest.json version match
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
assert.strictEqual(pkg.version, manifest.version, 'package.json and manifest.json versions must match');
assert.strictEqual(pkg.version, '3.5.20', 'Version should be 3.5.20');

console.log('✅ All Lightweight Backup & Reading Records tests passed successfully!');
