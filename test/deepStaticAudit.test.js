import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOTS = ['src', 'scripts', 'test'];
const PATTERNS = new Map([
  ['maps', /\bnew\s+Map\s*\(/g],
  ['sets', /\bnew\s+Set\s*\(/g],
  ['intervals', /\bsetInterval\s*\(/g],
  ['timeouts', /\bsetTimeout\s*\(/g],
  ['collectors', /createMessageComponentCollector\s*\(/g],
  ['modalWaits', /awaitModalSubmit\s*\(/g],
  ['promiseAll', /Promise\.all\s*\(/g],
  ['messageFetches', /messages\.fetch\s*\(/g],
  ['processHandlers', /process\.on\s*\(/g],
  ['cronJobs', /cron\.schedule\s*\(/g],
  ['directDbWrites', /(?:client\.)?db\.set\s*\(/g],
  ['infiniteLimits', /\bInfinity\b/g],
]);

async function walk(directory, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
    } else if (entry.name.endsWith('.js')) {
      files.push(fullPath.replace(/\\/g, '/'));
    }
  }
  return files;
}

function countMatches(text, regex) {
  return [...text.matchAll(regex)].length;
}

test('deep static audit scans every JavaScript source file', async () => {
  const files = [];
  for (const root of ROOTS) await walk(root, files);
  files.sort();

  const report = Object.fromEntries([...PATTERNS.keys()].map(key => [key, []]));
  let totalLines = 0;
  let totalBytes = 0;
  const largest = [];

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const lines = text.split(/\r?\n/).length;
    totalLines += lines;
    totalBytes += Buffer.byteLength(text);
    largest.push({ file, lines, bytes: Buffer.byteLength(text) });

    for (const [name, regex] of PATTERNS) {
      const count = countMatches(text, regex);
      if (count > 0) report[name].push(`${file}(${count})`);
    }
  }

  largest.sort((a, b) => b.bytes - a.bytes);
  console.log(`[DEEP_AUDIT] files=${files.length} lines=${totalLines} bytes=${totalBytes}`);
  console.log(`[DEEP_AUDIT] largest=${largest.slice(0, 20).map(item => `${item.file}:${item.lines}L`).join(',')}`);
  for (const [name, entries] of Object.entries(report)) {
    console.log(`[DEEP_AUDIT] ${name}=${entries.join(',')}`);
  }

  assert.ok(files.length >= 300, `Expected a full repository scan, got only ${files.length} JS files`);
  assert.ok(totalLines > 20_000, `Expected substantial source coverage, got only ${totalLines} lines`);
});
