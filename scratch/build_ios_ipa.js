const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const buildDir = path.join(rootDir, 'ios', 'build');
const outputIpaPath = path.join(rootDir, 'EdgeReader-iOS.ipa');

console.log('=== Step 1: Building distribution web assets ===');
execSync('node scratch/build_dist.js', { cwd: rootDir, stdio: 'inherit' });

console.log('\n=== Step 2: Syncing Capacitor iOS platform ===');
execSync('npx cap sync ios', { cwd: rootDir, stdio: 'inherit' });

console.log('\n=== Step 3: Compiling iOS App with xcodebuild (Release arm64) ===');
if (fs.existsSync(buildDir)) {
  fs.rmSync(buildDir, { recursive: true, force: true });
}
fs.mkdirSync(buildDir, { recursive: true });

const xcodeCmd = [
  'xcodebuild',
  '-workspace ios/App/App.xcworkspace',
  '-scheme App',
  '-configuration Release',
  "-destination 'generic/platform=iOS'",
  `-derivedDataPath "${buildDir}"`,
  'CODE_SIGNING_ALLOWED=NO',
  'CODE_SIGN_IDENTITY=""',
  'CODE_SIGNING_REQUIRED=NO',
  'build'
].join(' ');

execSync(xcodeCmd, { cwd: rootDir, stdio: 'inherit' });

console.log('\n=== Step 4: Packaging into IPA ===');
const appSource = path.join(buildDir, 'Build', 'Products', 'Release-iphoneos', 'App.app');
if (!fs.existsSync(appSource)) {
  console.error(`Error: App.app not found at ${appSource}`);
  process.exit(1);
}

const payloadDir = path.join(buildDir, 'Payload');
if (fs.existsSync(payloadDir)) {
  fs.rmSync(payloadDir, { recursive: true, force: true });
}
fs.mkdirSync(payloadDir, { recursive: true });

const appDest = path.join(payloadDir, 'App.app');
// Copy App.app into Payload/App.app
execSync(`cp -R "${appSource}" "${appDest}"`, { stdio: 'inherit' });

// Create IPA by zipping Payload
if (fs.existsSync(outputIpaPath)) {
  fs.unlinkSync(outputIpaPath);
}

console.log('Compressing Payload into .ipa...');
execSync(`zip -qr "${outputIpaPath}" Payload`, { cwd: buildDir, stdio: 'inherit' });

const stats = fs.statSync(outputIpaPath);
const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

console.log('\n🎉 ========================================================');
console.log(`🎉 iOS IPA successfully generated!`);
console.log(`📍 Path: ${outputIpaPath}`);
console.log(`📦 Size: ${sizeMB} MB`);
console.log('========================================================\n');
