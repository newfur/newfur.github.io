const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'www');

// Helper to copy directory recursively
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log('1. Compiling offline index.html...');
execSync('node scratch/compile_offline.js', { cwd: rootDir, stdio: 'inherit' });

console.log('2. Cleaning build target: www/');
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
}
fs.mkdirSync(distDir, { recursive: true });

console.log('3. Copying and patching compiled index.html for native runtime...');
let html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');

// Replace offline runtime marker with native runtime marker
html = html.replace(
  "window.__RACONTEUR_RUNTIME__ = 'offline'",
  "window.__RACONTEUR_RUNTIME__ = 'native'"
);

fs.writeFileSync(path.join(distDir, 'index.html'), html, 'utf8');

// Intentionally do NOT copy sw.js or manifest.webmanifest into www/
// Native apps use Capacitor, not PWA service workers.

console.log('4. Copying application icons...');
copyDirSync(path.join(rootDir, 'icons'), path.join(distDir, 'icons'));

console.log('5. Copying manifest.json for version detection...');
fs.copyFileSync(path.join(rootDir, 'manifest.json'), path.join(distDir, 'manifest.json'));

// Verify all local src/href in index.html resolve under www/
console.log('6. Verifying local references in www/index.html...');
const wwwHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
const localRefs = [];
// Match src="..." and href="..." that are not data:, http:, https:, //, or #
const refRegex = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
let match;
while ((match = refRegex.exec(wwwHtml)) !== null) {
  const ref = match[1];
  if (ref.startsWith('data:') || ref.startsWith('http:') || ref.startsWith('https:') ||
      ref.startsWith('//') || ref.startsWith('#') || ref.startsWith('javascript:') ||
      ref.startsWith('blob:')) continue;
  localRefs.push(ref);
}

let missingCount = 0;
for (const ref of localRefs) {
  const resolved = path.resolve(distDir, ref);
  if (!fs.existsSync(resolved)) {
    // Tolerate references that are dynamically created at runtime (e.g., reader/libs/mermaid.min.js in dynamic script loading)
    console.warn(`  [WARN] Local reference not found in www/: ${ref}`);
    missingCount++;
  }
}

if (missingCount > 0) {
  console.warn(`  ${missingCount} local reference(s) not found — these may be runtime-resolved or unused in native mode`);
}

console.log('Distribution build completed successfully!');
