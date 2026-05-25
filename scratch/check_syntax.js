const fs = require('fs');
const vm = require('vm');

try {
  const code = fs.readFileSync('/Users/burnfan/Documents/antigravity/mysterious-oppenheimer/reader/tts.js', 'utf8');
  // Since it's an ES Module, we wrap it or parse it to ensure syntax is valid.
  // We can compile it as a Script by replacing "export class" with "class" to check syntax in standard JS VM.
  const checkableCode = code.replace('export class', 'class');
  new vm.Script(checkableCode);
  console.log("tts.js Syntax is VALID!");
} catch (e) {
  console.error("Syntax Error detected in tts.js:", e.message);
  process.exit(1);
}
