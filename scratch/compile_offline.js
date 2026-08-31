const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');

// Verify version consistency between manifest.json and package.json (read-only check)
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  if (manifest.version && packageJson.version !== manifest.version) {
    console.error(`[Version Check] MISMATCH: manifest.json version "${manifest.version}" != package.json version "${packageJson.version}"`);
    process.exit(1);
  }
  console.log(`[Version Check] OK — both manifest.json and package.json are at version ${manifest.version}`);
} catch (e) {
  console.error('[Version Check] Failed to verify version consistency:', e.message);
  process.exit(1);
}

console.log('Starting offline compilation...');

// 1. Read locales messages.json
const locales = {
  en: JSON.parse(fs.readFileSync(path.join(rootDir, '_locales/en/messages.json'), 'utf8')),
  zh_TW: JSON.parse(fs.readFileSync(path.join(rootDir, '_locales/zh_TW/messages.json'), 'utf8')),
  zh_CN: JSON.parse(fs.readFileSync(path.join(rootDir, '_locales/zh_CN/messages.json'), 'utf8'))
};

// 2. JS Modules in order
const modules = [
  'reader/i18n.js',
  'reader/security/sanitize.js',
  'reader/security/render.js',
  'reader/library.js',
  'reader/operation-ownership.js',
  'reader/resource-ownership.js',
  'reader/parsers/epub-parser.js',
  'reader/parsers/azw3-parser.js',
  'reader/parsers/text-parser.js',
  'reader/parsers/comic-parser.js',
  'reader/tts.js',
  'reader/ai.js',
  'reader/reader.js'
];

let manifestVersion = "unknown";
try { manifestVersion = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8')).version; } catch(e) {}
let combinedJs = `window.__RACONTEUR_RUNTIME__ = 'offline';\nwindow.__APP_VERSION__ = "${manifestVersion}";\nconst _offlineLocales = ${JSON.stringify(locales, null, 2)};\n\n`;

for (const modPath of modules) {
  const fullPath = path.join(rootDir, modPath);
  let content = fs.readFileSync(fullPath, 'utf8');
  
  // Strip import statements
  content = content.replace(/^import\s+[\s\S]*?\s+from\s+['"].+?['"];?/gm, '');
  
  // Strip export prefixes
  content = content.replace(/\bexport\s+(class|function|async\s+function|const|let|var)\b/g, '$1');
  
  combinedJs += `// ==========================================\n// Module: ${modPath}\n// ==========================================\n`;
  combinedJs += content + '\n\n';
}

// 3. Read jszip.min.js, mind-elixir.js, mermaid.min.js and mind-elixir.css
const jszipJs = fs.readFileSync(path.join(rootDir, 'reader/libs/jszip.min.js'), 'utf8');
const dompurifyJs = fs.readFileSync(path.join(rootDir, 'reader/libs/dompurify.min.js'), 'utf8');
const mermaidJs = fs.readFileSync(path.join(rootDir, 'reader/libs/mermaid.min.js'), 'utf8');
const mindElixirJs = fs.readFileSync(path.join(rootDir, 'reader/libs/mind-elixir.js'), 'utf8');
const mindElixirCss = fs.readFileSync(path.join(rootDir, 'reader/libs/mind-elixir.css'), 'utf8');

// 4. Read reader.css
const readerCss = fs.readFileSync(path.join(rootDir, 'reader/reader.css'), 'utf8');

// 5. Read reader.html
let html = fs.readFileSync(path.join(rootDir, 'reader/reader.html'), 'utf8');

// Inline CSS
html = html.replace('<link rel="stylesheet" href="libs/mind-elixir.css">', () => `<style>${mindElixirCss}</style>`);
html = html.replace('<link rel="stylesheet" href="reader.css">', () => `<style>${readerCss}</style>`);

// Inline JSZIP, Mind Elixir and module scripts
const scriptJszipRegex = /<script src="libs\/jszip\.min\.js"><\/script>/i;
const scriptDompurifyRegex = /<script src="libs\/dompurify\.min\.js"><\/script>/i;
const scriptMindElixirRegex = /<script src="libs\/mind-elixir\.js"><\/script>/i;
const scriptModuleRegex = /<script type="module" src="reader\.js"><\/script>/i;

html = html.replace(scriptDompurifyRegex, () => `<script>${dompurifyJs}</script>`);
html = html.replace(scriptJszipRegex, () => `<script>${jszipJs}</script>`);
html = html.replace(scriptMindElixirRegex, () => `<script>${mindElixirJs}</script>`);

// Mermaid: inline the full library for self-contained offline artifact
const scriptMermaidRegex = /<script src="libs\/mermaid\.min\.js"><\/script>/i;
html = html.replace(scriptMermaidRegex, () => `<script>${mermaidJs}</script>`);

html = html.replace(scriptModuleRegex, () => `<script>${combinedJs}</script>`);

// Remove network font links so offline artifact has no external stylesheet deps.
// System font fallbacks in CSS variables remain functional.
html = html.replace(/<link[^>]*href="https:\/\/fonts\.googleapis\.com[^>]*>/gi, '');
html = html.replace(/<link[^>]*href="https:\/\/fonts\.gstatic\.com[^>]*>/gi, '');
html = html.replace(/<link[^>]*href="https:\/\/cdn\.jsdelivr\.net\/npm\/lxgw[^>]*>/gi, '');

// Fix relative paths: inline JS uses paths relative to reader/ dir,
// but the output HTML files live at root, so rewrite libs/ -> reader/libs/
html = html.replace(/script\.src\s*=\s*'libs\//g, "script.src = 'reader/libs/");

// 6. Write final offline files to root
fs.writeFileSync(path.join(rootDir, 'reader_offline.html'), html, 'utf8');
fs.writeFileSync(path.join(rootDir, 'index.html'), html, 'utf8');
console.log('Successfully compiled reader_offline.html and index.html!');
