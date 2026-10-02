import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stampPath = path.join(root, '.startup-patches.json');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const patches = packageJson.startupPatches;

// The legacy patches are ordered transformations, not individually repeatable.
// Skip them only when both their inputs and the complete resulting source match.
function fingerprint() {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(patches));
  function add(relative) {
    const absolute = path.join(root, relative);
    if (fs.statSync(absolute).isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) add(path.join(relative, entry));
    } else {
      hash.update(relative.replaceAll('\\', '/'));
      hash.update('\0');
      hash.update(fs.readFileSync(absolute));
    }
  }
  add('src');
  for (const patch of patches) add(patch);
  add('scripts/apply-startup-patches.js');
  return hash.digest('hex');
}

let previous;
try {
  previous = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (previous) {
  if (previous.fingerprint !== fingerprint()) {
    throw new Error('Patched source changed: use a clean checkout/build before applying startup patches.');
  }
  console.log('[STARTUP_PATCHES] Verified patched source; no rewrites needed.');
} else {
  for (const patch of patches) {
    const result = spawnSync(process.execPath, [patch], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
  }
  fs.writeFileSync(stampPath, JSON.stringify({ fingerprint: fingerprint() }) + '\n');
}
