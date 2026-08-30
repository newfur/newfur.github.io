import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const dom = new JSDOM('', { url: 'https://reader.example/' });
dom.window.DOMPurify = createDOMPurify(dom.window);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.FileReader = dom.window.FileReader;
globalThis.Blob = dom.window.Blob;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });

let nextObjectUrl = 0;
globalThis.URL = dom.window.URL;
globalThis.URL.createObjectURL = () => `blob:https://reader.example/parser-${++nextObjectUrl}`;
globalThis.URL.revokeObjectURL = () => {};

const { EpubParser } = await import('../../reader/parsers/epub-parser.js');
const { TextParser } = await import('../../reader/parsers/text-parser.js');
const { Azw3Parser } = await import('../../reader/parsers/azw3-parser.js');

const attackHtml = `
  <p onclick="alert(1)" style="color: red; background-image: url(javascript:bad)">Safe text</p>
  <table><tr><td>Safe cell</td></tr></table>
  <form><input value="secret"><button>Submit</button></form>
  <script>alert(1)</script>
  <a href="javascript:alert(1)">bad link</a>
  <svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red" /><animate attributeName="x" /><foreignObject><div>bad</div></foreignObject></svg>
`;

function assertSanitized(html) {
  assert.match(html, /Safe text/);
  assert.match(html, /<table>|Safe cell/);
  assert.match(html, /<circle[^>]+fill="red"/);
  assert.doesNotMatch(html, /<script\b|\sonclick=|<form\b|<input\b|<button\b|javascript:|<animate\b|foreignObject|background-image/i);
}

function parseHtml(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

function fakeZip(entries) {
  return {
    file(path) {
      if (!(path in entries)) return null;
      return {
        async(type) {
          if (type === 'blob') return new Blob([entries[path]], { type: path.endsWith('.png') ? 'image/png' : 'application/octet-stream' });
          return entries[path];
        },
      };
    },
  };
}

test('EPUB getContent sanitizes a parsed chapter and retains trusted local images and safe structure', async () => {
  const entries = {
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/book.opf" /></rootfiles></container>',
    'OPS/book.opf': `
      <package><metadata><title>Fixture</title><creator>Author</creator></metadata><manifest>
        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" />
        <item id="image" href="image.png" media-type="image/png" />
      </manifest><spine><itemref idref="chapter" /></spine></package>`,
    'OPS/chapter.xhtml': `<html><head><style>@import url(https://evil.example/x.css); p { color: red }</style><link rel="stylesheet" href="https://evil.example/book.css"></head><body>${attackHtml}<img src="image.png" alt="Local image"><a href="#note">internal text</a><p id="note">Note</p></body></html>`,
    'OPS/image.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  };
  globalThis.JSZip = { loadAsync: async () => fakeZip(entries) };
  const parser = new EpubParser({ size: 123 });

  const book = await parser.parse();
  const html = await book.chapters[0].getContent();

  assertSanitized(html);
  assert.match(html, /<img src="blob:https:\/\/reader\.example\/parser-\d+" alt="Local image">/);
  assert.match(html, /<a href="#note"[^>]*>internal text<\/a>/);
  assert.match(html, /id="note"/);
  assert.doesNotMatch(html, /<style\b|<link\b|evil\.example/i);
  assert.equal(parser.resourceUrls.length, 1);
});

test('EPUB returns escaped sanitized errors for missing chapters', async () => {
  const parser = new EpubParser({ size: 0 });
  parser.zip = fakeZip({});
  const html = await parser.loadChapterContent('<img src=x onerror=alert(1)>');

  assert.match(html, /Chapter file not found/);
  assert.equal(parseHtml(html).querySelector('img, [onerror]'), null);
});

test('Markdown getContent removes executable links and preserves formatting and internal links', async () => {
  const markdown = `# Chapter\nSafe text with **bold** and [internal](#note).\n\n[bad](javascript:alert(1))\n\n<table onclick="bad"><tr><td>literal table</td></tr></table>`;
  const bytes = new TextEncoder().encode(markdown);
  const parser = new TextParser({ name: 'fixture.md', size: bytes.length, arrayBuffer: async () => bytes.buffer }, 'md');

  const book = await parser.parse();
  const html = book.chapters[0].getContent();

  assert.match(html, /Safe text with <strong>bold<\/strong>/);
  assert.match(html, /href="#note"/);
  assert.match(html, /&lt;table onclick=/);
  assert.equal(parseHtml(html).querySelector('[onclick], a[href^="javascript:"]'), null);
});

test('FB2 getContent sanitizes converted XML and rejects malformed XML', async () => {
  const valid = new Blob([`<?xml version="1.0"?><FictionBook><description><title-info><book-title>Fixture</book-title></title-info></description><body><section><title><p>Chapter</p></title><p onclick="alert(1)" style="color: red; background-image: url(javascript:bad)">Safe text</p><table><tr><td>Safe cell</td></tr></table><form><input value="secret"/><button>Submit</button></form><script>alert(1)</script><a href="javascript:alert(1)">bad link</a><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/><animate attributeName="x"/><foreignObject><div>bad</div></foreignObject></svg></section></body></FictionBook>`], { type: 'text/xml' });
  Object.defineProperty(valid, 'name', { value: 'fixture.fb2' });
  const parser = new TextParser(valid, 'fb2');

  const book = await parser.parse();
  const html = book.chapters[0].getContent();

  assertSanitized(html);
  await assert.rejects(
    new TextParser(new Blob(['<FictionBook><body>'], { type: 'text/xml' }), 'fb2').parse(),
    /Invalid FB2 XML/,
  );
});

function makeMobiFile() {
  const pdb = new ArrayBuffer(102);
  new DataView(pdb).setUint16(76, 3);
  return { name: 'fixture.azw3', size: pdb.byteLength, arrayBuffer: async () => pdb };
}

function makeMobiParser(useNcx) {
  const html = `<html><body>${attackHtml}<img src="kindle:embed:1" alt="Embedded image"><a href="#note">internal</a><p id="note">Note</p></body></html>`;
  const encoder = new TextEncoder();
  class FixtureParser extends Azw3Parser {
    _parseRecord0() {
      this.compression = 1;
      this.textRecordCount = 1;
      this.mobiHeaderOffset = 16;
      this.extraDataFlags = 0;
      this.ncxIndex = useNcx ? 1 : 0xffffffff;
      this.huffmanRecordCount = 0;
    }

    _parseEXTH() {}

    _getRecordData(index) {
      if (index === 0) {
        const record = new Uint8Array(300);
        new DataView(record.buffer).setUint32(this.mobiHeaderOffset + 92, 2);
        return record;
      }
      if (index === 1) return encoder.encode(html);
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }

    _parseNCXTOC() {
      return useNcx ? [{ title: 'Fixture', pos: 0, depth: 0, charOffset: 0 }] : null;
    }
  }
  return new FixtureParser(makeMobiFile());
}

for (const [label, useNcx] of [['MOBI fallback', false], ['AZW3 NCX', true]]) {
  test(`${label} getContent sanitizes final replacements and retains trusted embedded images`, async () => {
    const book = await makeMobiParser(useNcx).parse();
    const html = book.chapters[0].getContent();

    assertSanitized(html);
    assert.match(html, /<img src="blob:https:\/\/reader\.example\/parser-\d+" alt="Embedded image">/);
    assert.match(html, /href="#note"/);
    assert.equal(book.resourceUrls.length, 1);
  });
}
