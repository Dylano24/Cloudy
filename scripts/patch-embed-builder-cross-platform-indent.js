import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const target = path.resolve(__dirname, '../src/web/embedColorPickerPage.js');
let source = fs.readFileSync(target, 'utf8');

// A braille blank is a real visible-width glyph, not collapsible whitespace.
// Discord desktop and mobile therefore keep the same manual indentation.
source = source.replace(
  "const onlyIndent = !currentLinePrefix || /^[\\u2063\\u2002\\u2009 ]+$/.test(currentLinePrefix);",
  "const onlyIndent = !currentLinePrefix || /^[\\u2800\\u2063\\u2002\\u2009 ]+$/.test(currentLinePrefix);",
);

source = source.replace(
  "const node = document.createTextNode(prefix + String.fromCharCode(8291) + String.fromCharCode(8194));",
  "const node = document.createTextNode(prefix + String.fromCharCode(10240));",
);

const serializerOld = `        while (allowNewlines && output.endsWith(newline)) output = output.slice(0, -1);\n        return output;`;
const serializerNew = `        while (allowNewlines && output.endsWith(newline)) output = output.slice(0, -1);\n        if (allowNewlines) {\n          output = output.split(newline).map(line => {\n            let index = 0;\n            let indent = '';\n            while (index < line.length) {\n              if (line.charCodeAt(index) === 10240) {\n                indent += String.fromCharCode(10240);\n                index += 1;\n                continue;\n              }\n              if (line.charCodeAt(index) === 8291 && (line.charCodeAt(index + 1) === 8194 || line.charCodeAt(index + 1) === 8201)) {\n                indent += String.fromCharCode(10240);\n                index += 2;\n                continue;\n              }\n              break;\n            }\n            return indent + line.slice(index);\n          }).join(newline);\n        }\n        return output;`;

if (!source.includes(serializerNew)) {
  if (!source.includes(serializerOld)) {
    console.error('[EMBED_BUILDER_CROSS_PLATFORM_INDENT] serializer marker not found');
    process.exit(1);
  }
  source = source.replace(serializerOld, serializerNew);
}

fs.writeFileSync(target, source, 'utf8');
console.log('[EMBED_BUILDER_CROSS_PLATFORM_INDENT] patched Discord desktop/mobile-safe manual indentation');
