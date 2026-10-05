import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Embed Manager normal open path stays registry-first', () => {
  const source = fs.readFileSync('src/services/embedManagerService.js', 'utf8');

  const loadStart = source.indexOf('async function loadCurrentRegistry');
  assert.ok(loadStart >= 0);

  const openStart = source.indexOf('export async function openEmbedManager', loadStart);
  assert.ok(openStart > loadStart);
  const loader = source.slice(loadStart, openStart);
  assert.match(loader, /const records = await getEmbedRegistry\(guild\.id\)/);
  assert.match(loader, /if \(records\.length\) return records/);

  const populatedPath = loader.slice(0, loader.indexOf('if (records.length) return records') + 36);
  assert.doesNotMatch(populatedPath, /reconcileEmbedRegistry\(guild\)/);
  assert.doesNotMatch(populatedPath, /scanGuildForCloudyEmbeds/);

  const openBody = source.slice(openStart);
  const collectorStart = openBody.indexOf("collector.on('collect'");
  const startupPart = collectorStart >= 0 ? openBody.slice(0, collectorStart) : openBody;
  assert.doesNotMatch(startupPart, /discoverEmbedManagerOverviewRecords\(/);

  const emptyRegistryGuard = startupPart.indexOf('if (!storedRecords.length)');
  const backgroundRegistryLoad = startupPart.indexOf('loadCurrentRegistry(', emptyRegistryGuard);
  assert.ok(emptyRegistryGuard >= 0 && backgroundRegistryLoad > emptyRegistryGuard);
});

test('full response history sweep is opt-in instead of automatic', () => {
  const source = fs.readFileSync('src/events/fullResponseCatalogReady.js', 'utf8');
  assert.match(source, /CLOUDY_HISTORY_BOOTSTRAP/);

  const readyStart = source.indexOf('execute(client)');
  const readyBody = source.slice(readyStart);
  const guard = readyBody.indexOf("process.env.CLOUDY_HISTORY_BOOTSTRAP === '1'");
  const scan = readyBody.indexOf('scanRecentBotResponses(client)');
  assert.ok(guard >= 0 && scan > guard);
});
