import fs from 'node:fs';
import path from 'node:path';

// Read-only inventory. Hits are review candidates, never proof of a bottleneck:
// dependency ordering, permissions and durable writes need manual inspection.
const patterns = {
  awaits: /\bawait\b/g,
  acknowledgement: /\.(?:reply|deferReply|deferUpdate|update|showModal|respond)\s*\(/g,
  fetches: /\.(?:fetch|fetchReply|fetchPinned|fetchPins)\s*\(/g,
  history: /(?:limit:\s*100|scanRecent|scanGuild|discoverRecent|reconcileEmbedRegistry)/g,
  synchronousIO: /\b(?:readFileSync|writeFileSync|readdirSync|statSync|spawnSync)\b/g,
  parallel: /Promise\.(?:all|allSettled)\s*\(/g,
  timers: /\b(?:setTimeout|setInterval)\s*\(/g,
};
const files = [];
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
      const source = fs.readFileSync(file, 'utf8');
      files.push({ file: file.replaceAll('\\', '/'), lines: source.split('\n').length,
        ...Object.fromEntries(Object.entries(patterns).map(([name, expression]) => [name, [...source.matchAll(expression)].length])) });
    }
  }
}
for (const root of ['src', 'scripts', 'test', '.github']) if (fs.existsSync(root)) visit(root);
files.sort((a, b) => a.file.localeCompare(b.file));
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), revisionScope: 'checkout including ordered startup transformations',
  counts: { files: files.length, lines: files.reduce((total, file) => total + file.lines, 0),
    sourceFiles: files.filter(file => file.file.startsWith('src/')).length }, files }, null, 2));
