const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const manifestPath = path.join(rootDir, 'manifest.json');
const packagePath = path.join(rootDir, 'package.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const parts = (manifest.version || '1.0.0').split('.').map(Number);
parts[2] = (parts[2] || 0) + 1;
const newVersion = parts.join('.');

manifest.version = newVersion;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.version = newVersion;
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`[Version Bump] Version updated to ${newVersion}`);

// Rebuild offline and dist assets with new version
console.log('[Version Bump] Rebuilding offline assets...');
execSync('node scratch/compile_offline.js', { cwd: rootDir, stdio: 'inherit' });
execSync('node scratch/build_dist.js', { cwd: rootDir, stdio: 'inherit' });

console.log(`[Version Bump] Successfully bumped version to ${newVersion} and updated builds.`);
