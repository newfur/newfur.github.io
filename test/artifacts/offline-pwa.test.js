import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..', '..');

describe('Offline artifact', () => {
  let html;

  before(() => {
    const filePath = path.join(rootDir, 'reader_offline.html');
    assert.ok(fs.existsSync(filePath), 'reader_offline.html must exist — run npm run build:offline first');
    html = fs.readFileSync(filePath, 'utf8');
  });

  it('reader_offline.html and index.html should be identical', () => {
    const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    assert.strictEqual(html, indexHtml, 'reader_offline.html and index.html must have identical content');
  });

  it('should contain __RACONTEUR_RUNTIME__ set to offline', () => {
    assert.ok(
      html.includes("window.__RACONTEUR_RUNTIME__ = 'offline'"),
      'offline artifact must set window.__RACONTEUR_RUNTIME__ to offline'
    );
  });

  it('should have no external functional <script src=...> tags', () => {
    const scriptSrcRegex = /<script[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match;
    const externalScripts = [];
    while ((match = scriptSrcRegex.exec(html)) !== null) {
      const src = match[1];
      if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')) {
        externalScripts.push(src);
      }
    }
    assert.deepStrictEqual(
      externalScripts, [],
      `Offline artifact should have no external script tags, found: ${externalScripts.join(', ')}`
    );
  });

  it('should have no external functional stylesheet links', () => {
    const linkRegex = /<link[^>]+href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi;
    let match;
    const externalStyles = [];
    while ((match = linkRegex.exec(html)) !== null) {
      externalStyles.push(match[1]);
    }
    assert.deepStrictEqual(
      externalStyles, [],
      `Offline artifact should have no external stylesheet links, found: ${externalStyles.join(', ')}`
    );
  });

  it('should inline _offlineLocales', () => {
    assert.ok(html.includes('_offlineLocales'), 'offline artifact must embed _offlineLocales');
  });

  it('should inline DOMPurify', () => {
    assert.ok(html.includes('DOMPurify'), 'offline artifact must inline DOMPurify');
  });

  it('should inline JSZip', () => {
    assert.ok(html.includes('JSZip'), 'offline artifact must inline JSZip');
  });

  it('should inline mermaid', () => {
    assert.ok(
      html.includes('mermaid') && !html.includes('src="reader/libs/mermaid.min.js"'),
      'offline artifact must inline mermaid, not reference it externally'
    );
  });
});

describe('Version consistency check', () => {
  it('manifest.json and package.json versions should match', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
    const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    assert.ok(manifest.version, 'manifest.json must have a version');
    assert.ok(packageJson.version, 'package.json must have a version');
    assert.strictEqual(manifest.version, packageJson.version, 'versions must match');
  });
});

describe('PWA relative paths', () => {
  it('manifest.webmanifest should use relative URLs', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.webmanifest'), 'utf8'));
    assert.ok(manifest.start_url.startsWith('./'), `start_url should be relative, got: ${manifest.start_url}`);
    for (const icon of manifest.icons) {
      assert.ok(icon.src.startsWith('./'), `icon src should be relative, got: ${icon.src}`);
    }
  });

  it('sw.js should use relative asset paths in precache list', () => {
    const swContent = fs.readFileSync(path.join(rootDir, 'sw.js'), 'utf8');
    assert.ok(swContent.includes("'./'"), 'sw.js precache should have relative ./ path');
    assert.ok(swContent.includes("'./index.html'"), 'sw.js precache should have relative ./index.html');
    assert.ok(swContent.includes("'./manifest.webmanifest'"), 'sw.js precache should have relative ./manifest.webmanifest');
    assert.ok(!swContent.includes("'/'"), 'sw.js should not have absolute root / path in precache');
    assert.ok(!swContent.includes("'/index.html'"), 'sw.js should not have absolute /index.html in precache');
  });

  it('reader.js PWA registration should guard on runtime !== offline and !== native', () => {
    const readerContent = fs.readFileSync(path.join(rootDir, 'reader', 'reader.js'), 'utf8');
    assert.ok(
      readerContent.includes("__RACONTEUR_RUNTIME__ !== 'offline'"),
      'PWA registration must check for offline runtime'
    );
    assert.ok(
      readerContent.includes("__RACONTEUR_RUNTIME__ !== 'native'"),
      'PWA registration must check for native runtime'
    );
  });
});
