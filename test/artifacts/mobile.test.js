import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..', '..');
const wwwDir = path.join(rootDir, 'www');

describe('Mobile artifact', () => {
  let html;

  before(() => {
    const filePath = path.join(wwwDir, 'index.html');
    assert.ok(fs.existsSync(filePath), 'www/index.html must exist — run npm run build:mobile first');
    html = fs.readFileSync(filePath, 'utf8');
  });

  it('should set __RACONTEUR_RUNTIME__ to native', () => {
    assert.ok(
      html.includes("window.__RACONTEUR_RUNTIME__ = 'native'"),
      'mobile artifact must set window.__RACONTEUR_RUNTIME__ to native'
    );
  });

  it('should NOT include sw.js in www/', () => {
    assert.ok(
      !fs.existsSync(path.join(wwwDir, 'sw.js')),
      'www/ must not contain sw.js'
    );
  });

  it('should NOT include manifest.webmanifest in www/', () => {
    assert.ok(
      !fs.existsSync(path.join(wwwDir, 'manifest.webmanifest')),
      'www/ must not contain manifest.webmanifest'
    );
  });

  it('should not register service worker when runtime is native', () => {
    // The native runtime flag prevents SW registration in the reader.js code path.
    // Since the combined JS includes the guard, verify the flag is set to native.
    assert.ok(
      html.includes("window.__RACONTEUR_RUNTIME__ = 'native'"),
      'mobile artifact must set native runtime to prevent service worker registration'
    );
    // Also verify the guard logic is present in the inline code
    assert.ok(
      html.includes("__RACONTEUR_RUNTIME__ !== 'native'"),
      'mobile artifact inline code must include native runtime guard'
    );
  });

  it('should have icons directory', () => {
    assert.ok(
      fs.existsSync(path.join(wwwDir, 'icons')),
      'www/icons/ must exist'
    );
  });

  it('should have manifest.json for version detection', () => {
    assert.ok(
      fs.existsSync(path.join(wwwDir, 'manifest.json')),
      'www/manifest.json must exist for version detection'
    );
  });
});
