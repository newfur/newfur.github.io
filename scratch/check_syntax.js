const fs = require('fs');
const vm = require('vm');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const htmlPath = path.join(rootDir, 'reader_offline.html');

if (!fs.existsSync(htmlPath)) {
  console.error('reader_offline.html does not exist!');
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const scriptRegex = /<script>([\s\S]*?)<\/script>/g;
let match;
let index = 1;

while ((match = scriptRegex.exec(html)) !== null) {
  const js = match[1];
  try {
    new vm.Script(js);
    console.log(`Script ${index} is syntactically valid.`);
  } catch (e) {
    console.error(`Syntax error in script ${index}:`);
    console.error(e.stack || e.message);
  }
  index++;
}
