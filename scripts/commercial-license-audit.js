import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const NODE_MODULES = path.resolve('node_modules');
const blockers = [];
const review = [];
const seen = new Set();

const BLOCKING_LICENSE = /(?:^|[^A-Z])(AGPL|GPL|SSPL|BUSL|BUSINESS\s+SOURCE|ELASTIC\s+LICENSE|COMMONS\s+CLAUSE)(?:[^A-Z]|$)/i;
const REVIEW_LICENSE = /(?:^|[^A-Z])(LGPL|MPL|EPL|CDDL|UNKNOWN|UNLICENSED)(?:[^A-Z]|$)/i;

function normalizeLicense(pkg) {
  if (typeof pkg?.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (pkg?.license && typeof pkg.license === 'object' && pkg.license.type) return String(pkg.license.type).trim();
  if (Array.isArray(pkg?.licenses)) {
    const values = pkg.licenses
      .map(value => typeof value === 'string' ? value : value?.type)
      .filter(Boolean)
      .map(String);
    if (values.length) return values.join(' OR ');
  }
  return 'UNKNOWN';
}

async function inspectPackage(packageDir) {
  const manifestPath = path.join(packageDir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    return;
  }

  const identity = `${pkg.name || packageDir}@${pkg.version || 'unknown'}`;
  if (!seen.has(identity)) {
    seen.add(identity);
    const license = normalizeLicense(pkg);
    const record = { identity, license };
    if (BLOCKING_LICENSE.test(license)) blockers.push(record);
    else if (REVIEW_LICENSE.test(license)) review.push(record);
  }

  await walkNodeModules(path.join(packageDir, 'node_modules'));
}

async function walkNodeModules(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    const entryPath = path.join(directory, entry.name);

    if (entry.name.startsWith('@')) {
      const scoped = await readdir(entryPath, { withFileTypes: true }).catch(() => []);
      for (const packageEntry of scoped) {
        if (packageEntry.isDirectory()) {
          await inspectPackage(path.join(entryPath, packageEntry.name));
        }
      }
      continue;
    }

    await inspectPackage(entryPath);
  }
}

await walkNodeModules(NODE_MODULES);

console.log(`[LICENSE_AUDIT] inspected ${seen.size} installed package versions.`);
if (review.length) {
  console.warn(`[LICENSE_AUDIT] ${review.length} package(s) need manual license review:`);
  for (const item of review) console.warn(`  - ${item.identity}: ${item.license}`);
}

if (blockers.length) {
  console.error(`[LICENSE_AUDIT] ${blockers.length} package(s) use a license that requires commercial distribution review:`);
  for (const item of blockers) console.error(`  - ${item.identity}: ${item.license}`);
  process.exitCode = 1;
} else {
  console.log('[LICENSE_AUDIT] no strong-copyleft/noncommercial blocker detected in installed dependencies.');
}
