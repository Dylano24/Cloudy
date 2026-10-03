import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import { saveEmbedTemplateDecoration, warmSavedEmbedTemplateScopes, getCachedSavedEmbedTemplateData } from '../src/services/embedTemplateService.js';
import { applySavedResponsePayloadTemplates } from '../src/events/fullResponseCatalogReady.js';
import { collapseDisplayRecords, loadRecordSnapshotIntoState } from '../src/services/embedManagerService.js';
import { buildBuilderEmbeds } from '../src/commands/Tools/embedbuilder.js';
import { buildEconomyLeaderboardEmbed } from '../src/commands/Economy/eleaderboard.js';
import { hydrateBuilderPreviewRecord, rememberBuilderRuntimePreview } from '../src/services/builderRuntimePreviewService.js';

const values = new Map();
db.initialized = true;
db.useFallback = false;
db.db = { get: async key => values.get(key), set: async (key, value) => { values.set(key, structuredClone(value)); return true; } };
const guildId = 'parity-guild';
const channelId = 'parity-channel';
function record(id, data, extra = {}) {
  return { guildId, channelId, messageId: id, embedIndex: 0, source: 'system-catalog', snapshot: data,
    title: data.title, name: data.title, createdAt: '2026-10-03T06:00:00Z', ...extra };
}

test('a sparse saved leaderboard title applies to runtime without clearing the actual ranking', async () => {
  await saveEmbedTemplateDecoration(guildId, channelId, ['Economy Leaderboard'], { title: 'Economy leaderboard', color: 0xFFFFFF });
  const source = { guildId, channelId, commandName: 'leaderboard' };
  const input = { title: 'Economy Leaderboard', description: '🥇 <@123> - 🏦 250', footer: { text: 'Your Rank: #1' } };
  const output = await applySavedResponsePayloadTemplates({ embeds: [input] }, source);
  assert.equal(output.embeds[0].title, 'Economy leaderboard');
  assert.equal(output.embeds[0].description, input.description);
  assert.deepEqual(output.embeds[0].footer, input.footer);
  const grouped = collapseDisplayRecords([record('old', { title: 'Economy Leaderboard' }), record('new', input, { source: 'modified' })], channelId);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].name, 'Economy leaderboard');
  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, { id: guildId }, grouped[0], grouped[0].previewRecord, grouped[0].sourceRecord), true);
  const preview = buildBuilderEmbeds(state)[0].toJSON();
  assert.equal(preview.title, 'Economy leaderboard');
  assert.equal(preview.description, input.description);
});

test('saved status styling never replaces another action’s actual response body', async () => {
  await saveEmbedTemplateDecoration(guildId, channelId, ['Success'], { title: 'Success', description: 'Duel complete!', color: 0x00C49D });
  const output = await applySavedResponsePayloadTemplates({ embeds: [{ title: 'Success', description: 'Money deposited', fields: [{ name: 'Balance', value: '100' }] }] }, { guildId, channelId });
  assert.equal(output.embeds[0].description, 'Money deposited');
  assert.equal(output.embeds[0].fields[0].value, '100');
});

test('generic named keys, source hashes, emoji and capitalization produce one entry per response title', () => {
  const records = ['Failed', '❌ failed', 'FAILED'].map((title, index) => record(String(index), { title, description: `Action ${index}`, author: { name: `Cloudy template key: ${index ? 'source:abcdef' : 'failed'} || Cloudy context: botlog/test || Cloudy kind: embed` } }));
  assert.equal(collapseDisplayRecords(records, channelId).length, 1);
});

test('a newer empty peer cannot suppress a complete real preview', () => {
  const full = record('full', { title: 'Details', description: 'Complete text', fields: [{ name: 'Field', value: 'Actual value' }] }, { source: 'modified' });
  const sparse = record('sparse', { title: 'Details' }, { source: 'modified', createdAt: '2026-10-03T07:00:00Z' });
  const selected = collapseDisplayRecords([full, sparse], channelId)[0];
  assert.equal(selected.previewRecord.messageId, 'full');
});

test('leaderboard preview and command use the same live data and rank formatter', async () => {
  const economy = new Map([['guild:parity-guild:economy:user1', { wallet: 50, bank: 100 }], ['guild:parity-guild:economy:user2', { wallet: 200, bank: 0 }]]);
  const client = { db: { list: async () => [...economy.keys()], get: async key => economy.get(key) } };
  const data = (await buildEconomyLeaderboardEmbed(client, guildId, 'user1')).toJSON();
  const preview = await hydrateBuilderPreviewRecord({ id: guildId, client }, record('leaderboard', { title: 'Economy leaderboard' }), null, 'user1');
  assert.deepEqual(preview.snapshot, data);
  assert.match(data.description, /<@user2>.*200/);
  assert.ok(data.description.indexOf('<@user2>') < data.description.indexOf('<@user1>'));
});

test('full command payloads survive transient message deletion as a reusable preview', async () => {
  const payload = { embeds: [{ title: 'Preview retained', description: 'Actual response', fields: [{ name: 'Value', value: '42' }] }] };
  await rememberBuilderRuntimePreview(payload, { guildId, channelId });
  const preview = await hydrateBuilderPreviewRecord({ id: guildId }, record('catalog', { title: 'Preview retained' }), null, 'user1');
  assert.deepEqual(preview.snapshot, payload.embeds[0]);
  await warmSavedEmbedTemplateScopes(guildId, [channelId]);
  assert.equal(getCachedSavedEmbedTemplateData(guildId, channelId, preview.snapshot).data.description, 'Actual response');
});
