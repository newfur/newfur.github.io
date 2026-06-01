import { EpubParser } from '../reader/parsers/epub-parser.js';
import fs from 'fs';

// Read EPUB as Blob
const epubPath = "/Users/burnfan/Downloads/Shi Jie De Luo Ji  - [Mei ] Da Wei _Ha Wei.epub";
const fileBuffer = fs.readFileSync(epubPath);
const fileBlob = new Blob([fileBuffer], { type: 'application/epub+zip' });

const parser = new EpubParser(fileBlob);
const res = await parser.parse();

console.log("EPUB parsed successfully.");
// Let's find index_split_006.html in res.chapters
const ch6 = res.chapters.find(ch => ch.cleanHref.includes("index_split_006.html"));
if (ch6) {
  console.log("Found Chapter 6:", ch6.title);
  const content = await ch6.getContent();
  
  // Let's search for data-epub-href inside content using a simple regex
  const regex = /data-epub-href=["']([^"']*)["']/g;
  let match;
  console.log("--- Rewritten Links in Chapter 6 (first 10) ---");
  let count = 0;
  while ((match = regex.exec(content)) !== null && count < 10) {
    console.log(`  data-epub-href: ${match[1]}`);
    count++;
  }
} else {
  console.log("Chapter 6 not found!");
}
