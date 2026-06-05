const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');

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
  'reader/library.js',
  'reader/parsers/epub-parser.js',
  'reader/parsers/azw3-parser.js',
  'reader/parsers/text-parser.js',
  'reader/parsers/comic-parser.js',
  'reader/tts.js',
  'reader/ai.js',
  'reader/reader.js'
];

let combinedJs = `const _offlineLocales = ${JSON.stringify(locales, null, 2)};\n\n`;

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

// 3. Read jszip.min.js
const jszipJs = fs.readFileSync(path.join(rootDir, 'reader/libs/jszip.min.js'), 'utf8');

// 4. Read reader.css
const readerCss = fs.readFileSync(path.join(rootDir, 'reader/reader.css'), 'utf8');

// 5. Read reader.html
let html = fs.readFileSync(path.join(rootDir, 'reader/reader.html'), 'utf8');

// Inline CSS
html = html.replace('<link rel="stylesheet" href="reader.css">', () => `<style>${readerCss}</style>`);

// Inline JSZIP and module scripts
const scriptJszipRegex = /<script src="libs\/jszip\.min\.js"><\/script>/i;
const scriptModuleRegex = /<script type="module" src="reader\.js"><\/script>/i;

html = html.replace(scriptJszipRegex, () => `<script>${jszipJs}</script>`);
html = html.replace(scriptModuleRegex, () => `<script>${combinedJs}</script>`);

// Mermaid: 不內聯（3.2MB 太大），僅修正路徑指向 reader/libs/
const scriptMermaidRegex = /<script src="libs\/mermaid\.min\.js"><\/script>/i;
html = html.replace(scriptMermaidRegex, '<script src="reader/libs/mermaid.min.js"></script>');

// Fix relative paths: inline JS uses paths relative to reader/ dir,
// but the output HTML files live at root, so rewrite libs/ -> reader/libs/
html = html.replace(/script\.src\s*=\s*'libs\//g, "script.src = 'reader/libs/");

// 6. Write final offline files to root
fs.writeFileSync(path.join(rootDir, 'reader_offline.html'), html, 'utf8');
fs.writeFileSync(path.join(rootDir, 'index.html'), html, 'utf8');
console.log('Successfully compiled reader_offline.html and index.html!');
