import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Embed Manager normal open path stays registry-first and live-only', () => {
  const source = fs.readFileSync('src/services/embedManagerService.js', 'utf8');

  const loadStart = source.indexOf('async function loadCurrentRegistry');
  assert.ok(loadStart >= 0);

  const openStart = source.indexOf('export async function openEmbedManager', loadStart);
  assert.ok(openStart > loadStart);
  const loader = source.slice(loadStart, openStart);
  assert.match(loader, /const records = await getEmbedRegistry\(guild\.id\)/);
  assert.match(loader, /if \(records\.length\) return records/);

  const followUp = source.indexOf('const managerMessage = await buttonInteraction.followUp', openStart);
  assert.ok(followUp > openStart);
  const firstPaint = source.slice(openStart, followUp);

  // First paint is DB/local only and excludes Search-only archive records.
  assert.match(firstPaint, /const allStoredRecords = await getEmbedRegistry\(guild\.id\)/);
  assert.match(firstPaint, /filterEmbedManagerRecords\([\s\S]*includeBotHistory: false/);
  assert.doesNotMatch(firstPaint, /discoverEmbedManagerOverviewRecords\(/);
  assert.doesNotMatch(firstPaint, /reconcileEmbedRegistry\(/);

  // Normal opening must not fan out across Discord channel history. Recovery is
  // reserved for the genuinely empty-registry path inside loadCurrentRegistry.
  const afterPaint = source.slice(followUp);
  assert.doesNotMatch(afterPaint, /discoverEmbedManagerOverviewRecords\(/);
  assert.match(afterPaint, /loadCurrentRegistry\(guild, buttonInteraction\.client\.user\.id\)/);
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
