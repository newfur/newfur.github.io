const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');

const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

let ok = true;

if (!manifest.version) {
  console.error('[Version Check] manifest.json has no version field');
  ok = false;
}

if (!packageJson.version) {
  console.error('[Version Check] package.json has no version field');
  ok = false;
}

if (manifest.version && packageJson.version && manifest.version !== packageJson.version) {
  console.error(`[Version Check] MISMATCH: manifest.json="${manifest.version}" vs package.json="${packageJson.version}"`);
  ok = false;
}

if (ok) {
  console.log(`[Version Check] OK — version ${manifest.version}`);
} else {
  process.exit(1);
}
