import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stampPath = path.join(root, '.startup-patches.json');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const patches = packageJson.startupPatches;

// The legacy patches are ordered transformations, not individually repeatable.
// Skip them only when both their inputs and the complete resulting source match.
function verifySourceSyntax(label) {
  const targets = [
    'src/commands/Tools/embedbuilder.js',
    'src/commands/Tools/zz_embedbuilderLiveSearchPatch.js',
    'src/services/embedManagerService.js',
  ];
  for (const relative of targets) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) continue;
    const checked = spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8' });
    if (checked.status !== 0) {
      const detail = String(checked.stderr || checked.stdout || '').trim();
      throw new Error(`${label} left invalid syntax in ${relative}:\n${detail}`);
    }
  }
}

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
  const syntaxTargets = [
    'src/commands/Tools/embedbuilder.js',
    'src/commands/Tools/zz_embedbuilderLiveSearchPatch.js',
  ];

  for (const patch of patches) {
    // Run the ordered transformations in one process so each reads the exact
    // source written by its predecessor before the final fingerprint is saved.
    await import(pathToFileURL(path.join(root, patch)).href);

    for (const relative of syntaxTargets) {
      const absolute = path.join(root, relative);
      if (!fs.existsSync(absolute)) continue;
      const checked = spawnSync(process.execPath, ['--check', absolute], {
        encoding: 'utf8',
      });
      if (checked.status !== 0) {
        const detail = String(checked.stderr || checked.stdout || '').trim();
        throw new Error(`Startup patch ${patch} broke syntax in ${relative}:\n${detail}`);
      }
    }
  }
  verifySourceSyntax('[STARTUP_PATCHES]');
  fs.writeFileSync(stampPath, JSON.stringify({ fingerprint: fingerprint() }) + '\n');
}
