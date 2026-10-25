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

  const followUp = source.indexOf('let managerMessage;', openStart);
  assert.ok(followUp > openStart);
  const firstPaint = source.slice(openStart, followUp);

  // First paint is DB/local only. Unsaved source templates belong to Search;
  // only explicitly saved source masters can be in their recorded channel.
  assert.match(firstPaint, /await getEmbedRegistry\(guild\.id\)/);
  assert.match(firstPaint, /projectCatalogTemplatesToFeatureChannels\(guild/);
  assert.match(firstPaint, /let records = accessibleRecords\(mergeEmbedManagerRecords\(/);
  assert.match(firstPaint, /\.\.\.savedChannelRecords/);
  assert.doesNotMatch(firstPaint, /getSearchableSystemCatalogRecords\(guild\.id\)/);
  assert.match(firstPaint, /embedManagerCheckingChannelIds\(guild, records\)/);
  assert.doesNotMatch(firstPaint, /discoverEmbedManagerOverviewRecords\(/);
  assert.doesNotMatch(firstPaint, /reconcileEmbedRegistry\(/);

  // The first paint stays registry-first. A bounded read-only recent-history
  // sweep now fills channel counts after the initial Discord response, without
  // persisting messages or rewriting templates.
  const afterPaint = source.slice(followUp);
  assert.match(afterPaint, /void discoverEmbedManagerOverviewRecords\(/);
  assert.match(afterPaint, /discoverRecentChannelEmbeds\(\s*guild, channelId/);
  assert.match(afterPaint, /discoverMissingChannelEmbeds\(/);
  assert.match(afterPaint, /verifyLiveBuilderChannelRecords\(/);
  assert.match(afterPaint, /const liveRecords = await verifyLiveBuilderChannelRecords/);
  assert.doesNotMatch(afterPaint, /mergeEmbedManagerRecords\(registeredRecords, discoveredRecords\)/);
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
