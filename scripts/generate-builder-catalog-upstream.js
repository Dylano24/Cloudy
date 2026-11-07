#!/usr/bin/env node
// Writes src/config/builderCatalogUpstream.json: the text fingerprints of every
// embed/text template in the original TitanBot code (codebymitch), before any
// Cloudy work started. The Builder policy uses it to tell an unchanged upstream
// example from a template that was made or reworded for Cloudy.
//
// Usage (needs the full git history): node scripts/generate-builder-catalog-upstream.js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { extractDefinitions } from '../src/services/embedDefinitionDiscoveryService.js';
import { templateTextSignature } from '../src/services/builderCatalogPolicy.js';
import { UPSTREAM_BASELINE_COMMIT, definitionSourcePath, isRetiredSourcePath } from '../src/config/builderCatalogManifest.js';
import { discoverEmbedDefinitions } from '../src/services/embedDefinitionDiscoveryService.js';
import { getSystemEmbedTemplateKey } from '../src/services/systemEmbedCatalogService.js';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const files = git('ls-tree', '-r', '--name-only', UPSTREAM_BASELINE_COMMIT, '--', 'src')
  .split('\n').filter(file => file.endsWith('.js'));
if (!files.length) throw new Error(`No source files found at ${UPSTREAM_BASELINE_COMMIT}; is the git history complete?`);

const signatures = new Set();
let definitions = 0;
for (const file of files) {
  const source = git('show', `${UPSTREAM_BASELINE_COMMIT}:${file}`);
  const relativePath = path.posix.relative('src', file);
  for (const definition of extractDefinitions(source, relativePath)) {
    const signature = templateTextSignature(definition);
    if (!signature) continue;
    definitions += 1;
    signatures.add(signature);
  }
}

// Template families of the retired command files, as the catalog stores them
// (context|key). They stay archived after the files themselves are removed.
const clean = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
const retiredFamilies = new Set();
for (const definition of await discoverEmbedDefinitions()) {
  if (clean(definition.kind) === 'content' || !isRetiredSourcePath(definitionSourcePath(definition))) continue;
  const context = clean(definition.context) || 'botlog';
  const title = String(definition.title || '').trim() || 'Untitled embed';
  const key = clean(getSystemEmbedTemplateKey('embed', title, definition.description || '', context));
  if (key) retiredFamilies.add(`${context}|${key}`);
}

const output = {
  baselineCommit: UPSTREAM_BASELINE_COMMIT,
  description: 'Text fingerprints of the original TitanBot templates (scripts/generate-builder-catalog-upstream.js).',
  files: files.length,
  definitions,
  signatures: [...signatures].sort(),
  retiredFamilies: [...retiredFamilies].sort(),
};
const target = path.resolve('src/config/builderCatalogUpstream.json');
fs.writeFileSync(target, `${JSON.stringify(output, null, 1)}\n`);
console.log(`Wrote ${output.signatures.length} upstream signatures from ${files.length} files and ${output.retiredFamilies.length} retired families to ${target}`);
process.exit(0);
