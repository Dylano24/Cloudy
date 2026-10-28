#!/usr/bin/env node
// Read-only branding inventory. Never rewrite source or leak secrets.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  .split('\0').filter(Boolean);
const candidates = paths.filter(path =>
  /(?:\.(?:js|cjs|mjs|ts|tsx|json|md|txt|yaml|yml|sh|env(?:\.example)?|toml)|(?:Dockerfile|Procfile))$/i.test(path)
  && !/(?:^|\/)(?:node_modules|dist|vendor|coverage|\.git)(?:\/|$)/.test(path)
  && !/package-lock\.json$|\.map$|\.min\.(?:js|css)$|\.b64(?:\.|$)/.test(path));
const patterns = [
  { name: 'TitanBot identifier or label', regex: /titanbot/ig },
  { name: 'Titan standalone label', regex: /\btitan(?!bot)(?:[\s_-]+(?:bot|manager))?\b/ig },
  { name: 'Titan prefix', regex: /\btitan[_-][a-z][\w-]*/ig },
  { name: 'Touchpoint Support', regex: /\btouchpoint\s+support\b/ig },
  { name: 'Dylano24', regex: /\bdylano24\b/ig },
  { name: 'Director', regex: /\bdirector\b/ig },
];

let scanned = 0, lines = 0;
const matches = [];
for (const path of candidates) {
  let content;
  try { content = readFileSync(path, 'utf8'); } catch { continue; }
  if (content.includes('\0')) continue;
  scanned++;
  const entries = content.split(/\r?\n/);
  lines += entries.length;
  for (let i = 0; i < entries.length; i++) {
    const original = entries[i];
    for (const pattern of patterns) {
      const hit = [...original.matchAll(pattern.regex)];
      if (!hit.length) continue;
      const area = path.startsWith('src/') ? 'runtime'
        : path.startsWith('test/') ? 'tests'
        : path.startsWith('scripts/') ? 'scripts'
        : path.startsWith('.github/') ? 'ci'
        : 'project';
      // Show matching token and only a short, restricted snippet. Never dump env lines.
      const snippet = /(^|\/)\.env/.test(path) ? '[configuration redacted]'
        : original.trim().slice(0, 160);
      matches.push({ area, path, line: i + 1, kind: pattern.name, count: hit.length, snippet });
    }
  }
}
const totals = {};
const byArea = {};
for (const match of matches) {
  totals[match.kind] = (totals[match.kind] || 0) + match.count;
  byArea[match.area] = (byArea[match.area] || 0) + match.count;
}
const unique = new Set(matches.map(m => m.path));
console.log(JSON.stringify({
  scanned, lines, matchingFiles: unique.size, totals, byArea,
  hits: matches.slice(0, 450),
  omittedHits: Math.max(0, matches.length - 450),
}, null, 2));
// Inventory only: the existence of legacy identifiers is not a test failure.
