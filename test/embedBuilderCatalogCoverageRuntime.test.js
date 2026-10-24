import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  getBuiltInSystemCatalogCoverage,
  getBuiltInSystemCatalogDefinitions,
} from '../src/services/systemEmbedCatalogService.js';

test('built-in catalog coverage explicitly includes Removed from Builder as a required response', () => {
  const definitions = getBuiltInSystemCatalogDefinitions();
  const removed = definitions.find(definition => definition.key === 'builder:removed');

  assert.ok(removed);
  assert.equal(removed.title, 'Removed from Builder');

  const coverage = getBuiltInSystemCatalogCoverage('coverage-empty-guild');
  assert.ok(coverage.expected > 0);
  assert.equal(coverage.complete, false);
  assert.ok(
    coverage.missing.some(entry => entry.key === 'builder:removed'),
    'an unindexed Removed from Builder response must be reported as missing',
  );
});

test('system catalog build fails closed when any built-in Search response is missing', () => {
  const source = fs.readFileSync('src/services/systemEmbedCatalogService.js', 'utf8');

  assert.match(source, /getBuiltInSystemCatalogCoverage\(guild\.id\)/);
  assert.match(source, /if \(!coverage\.complete\)/);
  assert.match(source, /Embed Builder system catalog incomplete/);
  assert.match(source, /catalogEnsurePromise = null/);
});

test('catalog ready event retries a failed or incomplete initialization', () => {
  const source = fs.readFileSync('src/events/systemEmbedCatalogReady.js', 'utf8');

  assert.match(source, /CATALOG_READY_ATTEMPTS = 3/);
  assert.match(source, /ensureCatalogReadyWithRetry/);
  assert.match(source, /await ensureSystemEmbedCatalogs\(client\)/);
  assert.match(source, /attempt < attempts/);
});

test('public health and readiness expose the live Railway revision and Search coverage', () => {
  const source = fs.readFileSync('src/app.js', 'utf8');

  assert.match(source, /RAILWAY_GIT_COMMIT_SHA/);
  assert.match(source, /RAILWAY_DEPLOYMENT_ID/);
  assert.match(source, /build: runtimeBuildInfo\(\)/);
  assert.match(source, /embedBuilderSearch:/);
  assert.match(source, /removedFromBuilderIndexed/);
  assert.match(source, /Embed Builder Search catalog incomplete/);
});


test('single and bulk Discord deletion invalidate the system Search catalog cache', () => {
  const single = fs.readFileSync('src/events/messageDelete.js', 'utf8');
  const bulk = fs.readFileSync('src/events/messageDeleteBulk.js', 'utf8');
  const catalog = fs.readFileSync('src/services/systemEmbedCatalogService.js', 'utf8');

  assert.match(single, /removeSystemEmbedCatalogMessage/);
  assert.match(bulk, /removeSystemEmbedCatalogMessage/);
  assert.match(catalog, /export async function removeSystemEmbedCatalogMessage/);
  assert.match(catalog, /catalogEnsurePromise = null/);
  assert.match(catalog, /storedIds\.map\(String\)\.filter/);
});
