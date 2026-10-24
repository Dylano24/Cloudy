import assert from 'node:assert/strict';
import test from 'node:test';
import { Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry, registerCloudyEmbedMessage, removeEmbedRegistryMessage, reconcileEmbedRegistry, updateDetachedEmbedRegistrySnapshot } from '../src/services/embedRegistryService.js';
import { isEmbedManagerVisibleRecord, verifyLiveBuilderChannelRecords } from '../src/services/embedManagerService.js';
import { buildMatches } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { captureSystemEmbedData } from '../src/services/systemEmbedCatalogService.js';

function fixture(t, guildId) {
  const values = new Map();
  t.mock.method(db, 'get', async key => structuredClone(values.get(key) ?? []));
  t.mock.method(db, 'set', async (key, value) => { values.set(key, structuredClone(value)); return true; });
  const message = {
    id: 'posted', guildId, channelId: 'general', channel: { id: 'general', name: 'general' },
    author: { id: 'bot' }, client: { user: { id: 'bot' } },
    createdAt: new Date('2026-10-24T00:00:00Z'), content: '',
    embeds: [new Embed({ title: 'Rules', description: 'Original channel content' })],
    components: [{ type: 1, components: [{ type: 2, style: 2, label: 'Open', custom_id: 'original_action' }] }],
    edit: async () => assert.fail('retention must never edit a Discord message'),
    delete: async () => assert.fail('retention must never delete a Discord message'),
  };
  return { message, values, guild: { id: guildId, channels: { cache: new Map() } }, registryKey: `cloudy:embed-registry:${guildId}` };
}

test('Post alone stays available for Modify/Save but creates no permanent Search template', async t => {
  const { message, guild } = fixture(t, 'post-without-save');
  assert.equal(await registerCloudyEmbedMessage(message, 'embed-builder'), true);
  const [record] = await getEmbedRegistry(guild.id);
  assert.equal(record.manualSaved, false);
  assert.equal(isEmbedManagerVisibleRecord(record), true, 'the live post must remain available to explicitly Save');
  assert.deepEqual(buildMatches(guild, [record], 'rules'), []);
  assert.equal(await removeEmbedRegistryMessage(guild.id, 'general', message.id), true);
  assert.deepEqual(await getEmbedRegistry(guild.id), []);
});

test('Builder drafts and posts never become automatically captured system templates', () => {
  for (const commandName of ['embedbuilder', 'simple_embed_post_channel', 'simple_embed_logo']) {
    assert.equal(captureSystemEmbedData({ title: 'An unsaved custom post', description: 'Draft content' }, {
      guildId: 'no-draft-capture', commandName,
    }), false);
  }
});

test('explicit Save retains a post and its buttons after Discord deletion', async t => {
  const { message, guild } = fixture(t, 'explicit-save-retained');
  await registerCloudyEmbedMessage(message, 'embed-builder');
  assert.equal(await registerCloudyEmbedMessage(message, 'embed-builder', { manualSave: true }), true);
  await removeEmbedRegistryMessage(guild.id, 'general', message.id);
  const [record] = await getEmbedRegistry(guild.id);
  assert.equal(record.manualSaved, true);
  assert.equal(record.detached, true);
  assert.equal(record.snapshot.description, 'Original channel content');
  assert.deepEqual(record.components, message.components);
  assert.equal(buildMatches(guild, [record], 'rules').length, 1);
});

test('a later automatic capture never revokes an explicit Save', async t => {
  const { message, guild } = fixture(t, 'saved-runtime-retained');
  await registerCloudyEmbedMessage(message, 'modified-template', { manualSave: true });
  await registerCloudyEmbedMessage(message, 'bot-history');
  const [live] = await getEmbedRegistry(guild.id);
  assert.equal(live.manualSaved, true);
  await removeEmbedRegistryMessage(guild.id, 'general', message.id);
  assert.equal((await getEmbedRegistry(guild.id))[0].manualSaved, true);
});

test('live reconciliation preserves explicit Save before a later Discord deletion', async t => {
  const { message, guild } = fixture(t, 'reconciled-save-retained');
  guild.client = message.client;
  guild.channels.cache.set('general', { id: 'general', messages: { fetch: async () => message } });
  await registerCloudyEmbedMessage(message, 'embed-builder', { manualSave: true });
  const result = await reconcileEmbedRegistry(guild);
  assert.equal(result.records[0].manualSaved, true);
  await removeEmbedRegistryMessage(guild.id, 'general', message.id);
  assert.equal((await getEmbedRegistry(guild.id))[0].manualSaved, true);
});

test('ambiguous legacy Builder data survives automatic reconciliation and deletion until explicitly saved', async t => {
  const { message, guild, values, registryKey } = fixture(t, 'legacy-save-retained');
  const legacy = { guildId: guild.id, channelId: 'general', messageId: message.id,
    source: 'embed-builder', embedIndex: 0, snapshot: { title: 'Rules', description: 'Legacy saved content' } };
  values.set(registryKey, [legacy]);
  guild.client = message.client;
  guild.channels.cache.set('general', { id: 'general', messages: { fetch: async () => message } });
  await reconcileEmbedRegistry(guild);
  assert.equal(Object.hasOwn((await getEmbedRegistry(guild.id))[0], 'manualSaved'), false);
  guild.channels.cache.get('general').messages.fetch = async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); };
  await reconcileEmbedRegistry(guild);
  const [detached] = await getEmbedRegistry(guild.id);
  assert.ok(detached, 'absence of a historical Save marker must not prove the content was never saved');
  assert.equal(detached.detached, true);
  assert.equal(Object.hasOwn(detached, 'manualSaved'), false);
  assert.equal(await updateDetachedEmbedRegistrySnapshot(guild.id, detached, { title: 'Rules', description: 'Explicitly saved now' }), true);
  const [saved] = await getEmbedRegistry(guild.id);
  assert.equal(saved.manualSaved, true);
  assert.equal(saved.snapshot.description, 'Explicitly saved now');
});

test('explicit Save of an already detached legacy record grants permanent retention', async t => {
  const { guild, values, registryKey } = fixture(t, 'detached-legacy-save');
  const legacy = { guildId: guild.id, channelId: 'general', messageId: 'legacy', source: 'embed-builder',
    embedIndex: 0, detached: true, snapshot: { title: 'Rules', description: 'Legacy content' } };
  values.set(registryKey, [legacy]);
  assert.equal(await updateDetachedEmbedRegistrySnapshot(guild.id, legacy, { title: 'Rules', description: 'Saved content' }), true);
  assert.equal((await getEmbedRegistry(guild.id))[0]?.manualSaved, true);
});

test('cleanup removes proven unsaved dead records while preserving live, saved, catalog and ambiguous legacy records', async t => {
  const { message, guild, values, registryKey } = fixture(t, 'save-only-cleanup');
  const base = { guildId: guild.id, channelId: 'general', source: 'embed-builder', embedIndex: 0,
    snapshot: { title: 'Rules', description: 'Original' }, detached: true };
  const saved = { ...base, messageId: 'saved', manualSaved: true };
  const legacy = { ...base, messageId: 'legacy-unclassified' };
  const live = { ...base, messageId: 'live', manualSaved: false, detached: false };
  const catalog = { ...base, messageId: 'catalog', source: 'system-catalog', manualSaved: false };
  values.set(registryKey, [
    { ...base, messageId: 'unsaved-post', manualSaved: false },
    { ...base, messageId: 'dead-history', source: 'bot-history', manualSaved: false },
    saved, legacy, live, catalog,
  ]);
  values.set('unrelated:report-history', { untouched: true });
  const records = await getEmbedRegistry(guild.id);
  assert.deepEqual(records.map(record => record.messageId).sort(), ['catalog', 'legacy-unclassified', 'live', 'saved']);
  assert.deepEqual(records.find(record => record.messageId === 'saved'), saved);
  await registerCloudyEmbedMessage({ ...message, id: 'next-live' }, 'embed-builder');
  const stored = values.get(registryKey);
  assert.equal(stored.some(record => ['unsaved-post', 'dead-history'].includes(record.messageId)), false);
  assert.deepEqual(stored.find(record => record.messageId === 'saved'), saved);
  assert.deepEqual(values.get('unrelated:report-history'), { untouched: true });
  await registerCloudyEmbedMessage({ ...message, id: 'legacy-unclassified' }, 'bot-history');
  const legacyAfterRefresh = (await getEmbedRegistry(guild.id)).find(record => record.messageId === 'legacy-unclassified');
  assert.equal(Object.hasOwn(legacyAfterRefresh, 'manualSaved'), false, 'an automatic refresh must not classify ambiguous legacy content as unsaved');
});

test('Modify channel excludes removed bot embeds, virtual catalog rows and unsaved registry snapshots', async () => {
  const guildId = 'live-only-registry-20261024';
  const channelId = '999999999999999998';
  const one = (messageId, source = 'bot-history', manualSaved = false) => ({
    guildId, channelId, messageId, source, manualSaved,
    snapshot: { title: 'Ping!', description: 'Old latency: 99ms' },
    embedIndex: 0,
  });
  const registered = [
    one('101', 'bot-history', false),
    one('102', 'system-catalog', false),
    { ...one('103', 'embed-builder', true), detached: true },
    one('104', 'embed-builder', false),
  ];
  const requested = [];
  const channel = { id: channelId, messages: {
    fetch: async id => { requested.push(String(id)); return null; },
  } };
  const guild = { id: guildId, channels: { cache: new Map([[channelId, channel]]) } };
  const visible = await verifyLiveBuilderChannelRecords(guild, channelId, registered, 'bot', []);
  assert.deepEqual(visible, []);
  assert.deepEqual(requested, [], 'only explicit saved non-detached candidates may need an ID check');
});

test('Modify channel revalidates older explicitly saved posts and keeps their real buttons', async () => {
  const guildId = 'live-manual-save-20261024';
  const channelId = '999999999999999997';
  const saved = {
    guildId, channelId, messageId: '120', source: 'embed-builder',
    manualSaved: true, embedIndex: 0,
    snapshot: { title: 'Old saved message', description: 'No longer in the latest page' },
  };
  const liveMessage = {
    author: { id: 'bot' },
    embeds: [{ toJSON: () => ({ title: 'Current title', description: 'Current Discord content' }) }],
    components: [{ toJSON: () => ({ type: 1, components: [] }) }],
  };
  const channel = { id: channelId, messages: {
    fetch: async id => id === saved.messageId ? liveMessage : null,
  } };
  const guild = { id: guildId, channels: { cache: new Map([[channelId, channel]]) } };
  const visible = await verifyLiveBuilderChannelRecords(guild, channelId, [saved], 'bot');
  assert.equal(visible.length, 1);
  assert.equal(visible[0].manualSaved, true);
  assert.equal(visible[0].snapshot.title, 'Current title');
  assert.equal(visible[0].snapshot.description, 'Current Discord content');
  assert.deepEqual(visible[0].components, [{ type: 1, components: [] }]);
  channel.messages.fetch = async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); };
  assert.deepEqual(await verifyLiveBuilderChannelRecords(guild, channelId, [saved], 'bot'), [],
    'a deleted saved embed stays in Search but cannot be displayed as a live channel message');
});

test('Modify channel keeps freshly verified Discord messages without permanently saving them', async () => {
  const guildId = 'live-temporary-response';
  const channelId = '999999999999999996';
  const runtime = {
    guildId, channelId, messageId: '200', source: 'embed-builder',
    embedIndex: 0, snapshot: { title: 'Appeal form' },
  };
  const channel = { id: channelId, messages: { fetch: async () => assert.fail('fresh result needs no second fetch') } };
  const guild = { id: guildId, channels: { cache: new Map([[channelId, channel]]) } };
  const visible = await verifyLiveBuilderChannelRecords(guild, channelId,
    [{ ...runtime, source: 'bot-history' }], 'bot', [runtime]);
  assert.deepEqual(visible.map(item => item.messageId), ['200']);
  assert.equal(visible[0].manualSaved, undefined, 'discovering a message never saves it as a manual template');
});
