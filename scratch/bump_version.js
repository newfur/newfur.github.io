const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const manifestPath = path.join(rootDir, 'manifest.json');
const packagePath = path.join(rootDir, 'package.json');

const pbxprojPath = path.join(rootDir, 'ios/App/App.xcodeproj/project.pbxproj');
const readmePaths = [
  path.join(rootDir, 'README.md'),
  path.join(rootDir, 'README.en.md'),
  path.join(rootDir, 'README.zh-TW.md')
];

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const currentVersion = manifest.version || '1.0.0';
const parts = currentVersion.split('.').map(Number);
parts[2] = (parts[2] || 0) + 1;
const newVersion = parts.join('.');

manifest.version = newVersion;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.version = newVersion;
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

// Update README version badges and release links
readmePaths.forEach(readmePath => {
  if (fs.existsSync(readmePath)) {
    let content = fs.readFileSync(readmePath, 'utf8');
    content = content.replace(
      new RegExp(`badge/version-${currentVersion.replace(/\\./g, '\\.')}-orange`, 'g'),
      `badge/version-${newVersion}-orange`
    );
    content = content.replace(
      new RegExp(`releases/tag/v${currentVersion.replace(/\\./g, '\\.')}`, 'g'),
      `releases/tag/v${newVersion}`
    );
    fs.writeFileSync(readmePath, content, 'utf8');
  }
});

// Update Xcode project MARKETING_VERSION
if (fs.existsSync(pbxprojPath)) {
  let content = fs.readFileSync(pbxprojPath, 'utf8');
  content = content.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${newVersion};`);
  fs.writeFileSync(pbxprojPath, content, 'utf8');
}

console.log(`[Version Bump] Version updated to ${newVersion}`);
