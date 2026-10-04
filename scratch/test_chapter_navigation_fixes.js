const assert = require('assert');
const fs = require('fs');

console.log('--- Running Chapter Navigation & iOS Memory Optimization Tests ---');

const readerSource = fs.readFileSync('reader/reader.js', 'utf8');
const readerCss = fs.readFileSync('reader/reader.css', 'utf8');

// 1. Verify reader-page-transition is NOT applied on uncapped scroll containers
assert.match(
  readerCss,
  /body\.layout-paginated\s+\.reader-container\s*\{\s*view-transition-name:\s*reader-page-transition;/i,
  'view-transition-name: reader-page-transition must only be scoped to body.layout-paginated'
);
assert.match(
  readerCss,
  /body:not\(\.layout-paginated\)\s+\.reader-container\s*\{\s*view-transition-name:\s*none\s*!important;/i,
  'body:not(.layout-paginated) must disable view-transition-name on .reader-container to prevent iOS GPU memory explosion'
);

// 2. Verify intra-file sub-chapter optimization in loadChapter
assert.match(
  readerSource,
  /isSamePhysicalFile\s*=\s*currentlyLoadedCleanHref\s*&&/i,
  'loadChapter must track currentlyLoadedCleanHref and optimize intra-file navigation without tearing down DOM'
);

// 3. Verify buildBookSearchIndex reads raw text directly from zip and deduplicates files
assert.match(
  readerSource,
  /fileHtmlCache\.has\(ch\.cleanHref\)/i,
  'buildBookSearchIndex must cache and deduplicate HTML text by cleanHref'
);
assert.match(
  readerSource,
  /epubBookData\.zip\.file\(ch\.cleanHref\)\.async\('string'\)/i,
  'buildBookSearchIndex must read raw strings directly from zip without calling ch.getContent()'
);

// 4. Verify navigatePage boundary logic skips sibling chapters with the same cleanHref
assert.match(
  readerSource,
  /while\s*\(nextIdx\s*<\s*epubBookData\.chapters\.length\s*&&\s*epubBookData\.chapters\[nextIdx\]\.cleanHref\s*===\s*currentHref\)/i,
  'navigatePage(next) must skip sibling chapters sharing cleanHref at document boundary'
);
assert.match(
  readerSource,
  /while\s*\(prevIdx\s*>=\s*0\s*&&\s*epubBookData\.chapters\[prevIdx\]\.cleanHref\s*===\s*currentHref\)/i,
  'navigatePage(prev) must skip sibling chapters sharing cleanHref at document boundary'
);

// 5. Verify popstate supports navigating back across chapters
assert.match(
  readerSource,
  /window\.addEventListener\('popstate',\s*\(e\)\s*=>\s*\{[\s\S]*?typeof\s*e\.state\.chapterIndex\s*===\s*'number'/i,
  'popstate listener must support chapter navigation before exiting book'
);

console.log('✅ All Chapter Navigation & iOS Memory Optimization tests passed successfully!');
