import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry } from '../src/services/embedRegistryService.js';
import * as catalogService from '../src/services/systemEmbedCatalogService.js';
const { getSystemEmbedTemplateKey, rememberCodeDiscoveredCatalogKeys, ensureUsedBuilderCatalogLoaded } = catalogService;
import { filterEmbedManagerRecords, loadRecordSnapshotIntoState } from '../src/services/embedManagerService.js';
import { loadFastEmbedBuilderSearchRecords } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

const optional = {kind: 'embed', context: 'utility/shorten', title: 'Old shortened link', description: 'Original source body.', color: 0xFFFFFF};
const cloudy = {kind: 'embed', context: 'giveaway/manage', title: 'Giveaway management', description: 'Current Cloudy controls.', color: 0xFFFFFF};
const keyOf = d => d.key || getSystemEmbedTemplateKey(d.kind, d.kind === 'content' ? '' : d.title, d.description, d.context);
let nextId = 1532882647838229100n;
function row(guildId, definition, extra = {}) {
  nextId++;
  return {guildId, channelId: '1532882647838229001', messageId: String(nextId), embedIndex: 0,
    source: 'system-catalog', title: definition.title || definition.label,
    snapshot: {title: definition.title || definition.label, description: definition.description, color: 0xFFFFFF,
      author: {name: `Cloudy template key: ${keyOf(definition)} || Cloudy context: ${definition.context} || Cloudy kind: ${definition.kind}`}},
    createdAt: '2026-11-07T06:00:00Z', ...extra};
}
async function fixture(t, id, rows, used = []) {
  const values = new Map([['cloudy:embed-registry:' + id, rows], ['cloudy:embed-builder-used-catalog:' + id, used]]);
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(values.has(key) ? values.get(key) : fallback ?? null));
  t.mock.method(db, 'set', async (key, value) => {values.set(key, structuredClone(value)); return true;});
  await getEmbedRegistry(id, {cached: true});
  await ensureUsedBuilderCatalogLoaded(id);
  const guild = {id, channels: {cache: new Map()}, members: {me: null}};
  return () => loadFastEmbedBuilderSearchRecords({guild, guildId: id, member: null}, {unfiltered: true});
}

test('Search hides never-used legacy examples, including automatic manualSaved copies, while preserving a color-only owner edit', async t => {
  const id = 'policy-routes-owner-color';
  rememberCodeDiscoveredCatalogKeys([optional, cloudy]);
  const custom = row(id, optional, {manualSaved: true});
  custom.snapshot.color = 0x123456;
  const approved = row(id, cloudy);
  const load = await fixture(t, id, [row(id, optional), row(id, optional, {manualSaved: true}), custom, approved]);
  const result = await load();
  assert.deepEqual(result.map(r => r.messageId).sort(), [custom.messageId, approved.messageId].sort());
  assert.equal(result.filter(r => r.snapshot.title === optional.title).length, 1);
  assert.equal(result.find(r => r.snapshot.title === optional.title).snapshot.color, 0x123456);
});

test('a separately saved manual post with the same title does not admit an unrelated legacy catalog family', async t => {
  const id = 'policy-routes-title-collision';
  rememberCodeDiscoveredCatalogKeys([optional]);
  const own = row(id, optional, {source: 'embed-builder', manualSaved: true, explicitSave: true,
    snapshot: {title: optional.title, description: 'My own unrelated panel.'}});
  const load = await fixture(t, id, [row(id, optional), own]);
  assert.deepEqual((await load()).map(r => r.messageId), [own.messageId]);
});

test('removing a discovered source does not bring its old cached catalog entry back', async t => {
  const id = 'policy-routes-removed-source';
  rememberCodeDiscoveredCatalogKeys([optional]);
  const load = await fixture(t, id, [row(id, optional)]);
  assert.equal((await load()).length, 0);
  rememberCodeDiscoveredCatalogKeys([cloudy]);
  assert.equal((await load()).length, 0);
});

test('unused plain-text source templates do not bypass the Builder policy', async t => {
  const id = 'policy-routes-content';
  const plain = {kind: 'content', key: 'old-plain-utility', context: 'utility/calculate', label: 'Calculation history', description: 'Old calculation reply.', color: 0xFFFFFF};
  rememberCodeDiscoveredCatalogKeys([plain, cloudy]);
  const load = await fixture(t, id, [row(id, plain)]);
  assert.equal((await load()).length, 0);
});

test('Modify uses the same archive rule as Search while retaining owner edits', async t => {
  const id = 'policy-routes-modify';
  rememberCodeDiscoveredCatalogKeys([optional]);
  const original = row(id, optional, {channelId: 'logical', backingChannelId: 'physical'});
  const saved = row(id, optional, {channelId: 'logical', backingChannelId: 'physical', explicitSave: true});
  await fixture(t, id, [original, saved]);
  assert.deepEqual(filterEmbedManagerRecords([original, saved]).map(r => r.messageId), [saved.messageId]);
  const state = {title: 'My current draft'};
  assert.equal(loadRecordSnapshotIntoState(state, {id}, original), false);
  assert.deepEqual(state, {title: 'My current draft'}, 'a stale hidden selection cannot replace the current draft');
});

test('static catalog writers admit Cloudy features and exact historical use while skipping never-used examples', async t => {
  const id = 'policy-routes-admission';
  await fixture(t, id, [], []);
  assert.equal(typeof catalogService.shouldSeedBuilderCatalogDefinition, 'function');
  assert.equal(catalogService.shouldSeedBuilderCatalogDefinition(optional, id), false);
  assert.equal(catalogService.shouldSeedBuilderCatalogDefinition(cloudy, id), true);
  catalogService.markBuilderCatalogUsed(id, keyOf(optional));
  assert.equal(catalogService.shouldSeedBuilderCatalogDefinition(optional, id), true);
  assert.equal(catalogService.shouldSeedBuilderCatalogDefinition(optional, 'other-server'), false);
});

test('an actually sent plain response is admitted just like a sent embed', async t => {
  const id = 'policy-routes-used-plain';
  const plain = {kind: 'content', key: 'plain-shorten-reply', context: 'botlog/shorten', label: 'Shorten reply', description: 'This link cannot be shortened.'};
  catalogService.registerDiscoveredEmbedDefinition(plain);
  rememberCodeDiscoveredCatalogKeys([plain]);
  const record = row(id, plain);
  const load = await fixture(t, id, [record]);
  assert.equal((await load()).length, 0);
  catalogService.applyPlainResponseTemplate({content: plain.description}, {commandName: 'shorten', guildId: id}, {capture: true});
  assert.equal((await load()).length, 1);
});
