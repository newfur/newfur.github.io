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

console.log('3. Copying compiled index.html to www/index.html');
fs.copyFileSync(path.join(rootDir, 'index.html'), path.join(distDir, 'index.html'));

console.log('4. Copying reader/libs/mermaid.min.js and dompurify.min.js to www/reader/libs/');
const destLibsDir = path.join(distDir, 'reader', 'libs');
fs.mkdirSync(destLibsDir, { recursive: true });
fs.copyFileSync(
  path.join(rootDir, 'reader/libs/mermaid.min.js'),
  path.join(destLibsDir, 'mermaid.min.js')
);
fs.copyFileSync(
  path.join(rootDir, 'reader/libs/dompurify.min.js'),
  path.join(destLibsDir, 'dompurify.min.js')
);

console.log('5. Copying application icons...');
copyDirSync(path.join(rootDir, 'icons'), path.join(distDir, 'icons'));

console.log('6. Copying manifest.json for version detection...');
fs.copyFileSync(path.join(rootDir, 'manifest.json'), path.join(distDir, 'manifest.json'));

console.log('Distribution build completed successfully!');
