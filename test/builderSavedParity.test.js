import test from 'node:test';
import assert from 'node:assert/strict';
import { Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import { saveEmbedTemplateDecoration, warmSavedEmbedTemplateScopes, getCachedSavedEmbedTemplateData } from '../src/services/embedTemplateService.js';
import { applySavedResponsePayloadTemplates } from '../src/events/fullResponseCatalogReady.js';
import { collapseDisplayRecords, loadRecordSnapshotIntoState, saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { buildBuilderEmbeds } from '../src/commands/Tools/embedbuilder.js';
import { buildEconomyLeaderboardEmbed } from '../src/commands/Economy/eleaderboard.js';
import { hydrateBuilderPreviewRecord, rememberBuilderRuntimePreview } from '../src/services/builderRuntimePreviewService.js';
import {
  applyRuntimeEmbedTemplateData,
  getSystemEmbedTemplateKey,
  primeSystemEmbedTemplateData,
  primeSystemSourceDefinitionPreview,
} from '../src/services/systemEmbedCatalogService.js';
import { buildMatches } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

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


test('Search and channel selection show a complete saved template before any edit', async () => {
  const searchGuildId = 'search-complete-guild';
  const searchChannelId = '1532882647838228799';
  const source = {
    key: 'source:payment-success',
    kind: 'embed',
    title: 'Payment Successful',
    description: 'You successfully paid {dynamic} the amount of {dynamic}!',
    fields: [
      { name: 'Payment Amount', value: '{dynamic}', inline: false },
      { name: 'Your New Balance', value: '{dynamic}', inline: false },
    ],
    context: 'gambling/pay',
  };
  primeSystemSourceDefinitionPreview(source);
  await saveEmbedTemplateDecoration(
    searchGuildId,
    searchChannelId,
    [source.title],
    { title: 'Payment successful', color: 0x00C49D },
  );
  await warmSavedEmbedTemplateScopes(searchGuildId, [searchChannelId]);

  const sparse = {
    guildId: searchGuildId,
    channelId: searchChannelId,
    messageId: '1532882647838228800',
    embedIndex: 0,
    source: 'system-catalog',
    title: source.title,
    name: source.title,
    snapshot: {
      title: source.title,
      color: 0x00C49D,
      author: {
        name: 'Cloudy template key: source:payment-success || Cloudy context: gambling/pay || Cloudy kind: embed',
      },
    },
    createdAt: '2026-10-03T09:00:00.000Z',
  };

  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, { id: searchGuildId }, sparse), true);
  const preview = buildBuilderEmbeds(state)[0].toJSON();
  assert.equal(preview.title, 'Payment successful');
  assert.equal(preview.description, source.description);
  assert.deepEqual(preview.fields, source.fields);

  const guild = {
    channels: {
      cache: new Map([[searchChannelId, { id: searchChannelId, name: 'gambling' }]]),
    },
  };
  const titleMatches = buildMatches(guild, [sparse], 'payment successful');
  assert.equal(titleMatches.length, 1);
  assert.equal(titleMatches[0].document.title, 'Payment successful');
  const bodyMatches = buildMatches(guild, [sparse], 'successfully paid');
  assert.equal(bodyMatches.length, 1);
});

test('a second Save updates the original template alias and keeps dynamic values dynamic', async () => {
  const repeatGuildId = 'repeat-save-guild';
  const repeatChannelId = '1532882647838228810';
  const original = {
    title: 'Payment Successful',
    description: 'You successfully paid {dynamic} the amount of {dynamic}!',
    color: 0x00C49D,
    author: {
      name: 'Cloudy template key: source:payment-success-repeat || Cloudy context: gambling/pay || Cloudy kind: embed',
    },
  };

  await saveEmbedTemplateDecoration(
    repeatGuildId,
    repeatChannelId,
    [original.title],
    { ...original, title: 'First saved title' },
  );
  await warmSavedEmbedTemplateScopes(repeatGuildId, [repeatChannelId]);

  const liveFirst = getCachedSavedEmbedTemplateData(
    repeatGuildId,
    repeatChannelId,
    { ...original, description: 'You successfully paid mindzset the amount of $200!' },
  ).data;
  assert.equal(liveFirst.title, 'First saved title');

  const message = {
    id: '1532882647838228811',
    guildId: repeatGuildId,
    channelId: repeatChannelId,
    author: { id: 'cloudy-bot' },
    flags: { has: () => false },
    createdAt: new Date('2026-10-03T09:05:00.000Z'),
    embeds: [new Embed(liveFirst)],
  };
  const channel = {
    id: repeatChannelId,
    messages: {
      fetch: async () => message,
      edit: async (_id, payload) => message.edit(payload),
    },
  };
  message.channel = channel;
  message.edit = async payload => {
    message.embeds = payload.embeds.map(data => new Embed(data));
    return message;
  };
  const guild = {
    id: repeatGuildId,
    client: { user: { id: 'cloudy-bot' } },
    channels: {
      cache: new Map([[repeatChannelId, channel]]),
      fetch: async id => (id === repeatChannelId ? channel : null),
    },
  };

  const state = {
    title: 'Second saved title',
    message: 'You successfully paid mindzset the amount of $200!',
    embedFields: [],
    sideColor: 0x00C49D,
    showLogo: false,
    removeExistingLogo: false,
    bottomLine: null,
    mediaUrl: null,
    modifyTarget: {
      guildId: repeatGuildId,
      channelId: repeatChannelId,
      backingChannelId: repeatChannelId,
      messageId: message.id,
      embedIndex: 0,
      source: 'modified-template',
      sourceEmbedData: liveFirst,
      templateSourceData: original,
      previewSourceData: {
        ...liveFirst,
        description: 'You successfully paid mindzset the amount of $200!',
      },
      catalogTitle: original.title,
      templateMode: true,
      templateTitle: 'source:payment-success-repeat',
      cachedMessage: message,
    },
  };

  const saved = await saveModifiedEmbed(guild, state);
  assert.equal(saved.ok, true);

  const future = getCachedSavedEmbedTemplateData(
    repeatGuildId,
    repeatChannelId,
    { ...original, description: 'You successfully paid another-user the amount of $500!' },
  ).data;
  assert.equal(future.title, 'Second saved title');
  assert.equal(future.description, 'You successfully paid another-user the amount of $500!');
});


test('member-specific Balance titles share one reusable response identity and runtime preview', async () => {
  const dynamicGuildId = 'dynamic-balance-guild';
  const dynamicChannelId = 'dynamic-balance-channel';
  const firstKey = getSystemEmbedTemplateKey(
    'embed',
    "feelfate's Balance",
    'Here is the current financial status for feelfate.',
    'gambling/balance',
  );
  const secondKey = getSystemEmbedTemplateKey(
    'embed',
    "anotheruser's Balance",
    'Here is the current financial status for anotheruser.',
    'gambling/balance',
  );
  assert.equal(firstKey, secondKey);

  const payload = {
    embeds: [{
      title: "feelfate's Balance",
      description: 'Here is the current financial status for feelfate.',
      fields: [{ name: 'Cash', value: '$100', inline: true }],
    }],
  };
  await rememberBuilderRuntimePreview(payload, { guildId: dynamicGuildId, channelId: dynamicChannelId });

  const preview = await hydrateBuilderPreviewRecord(
    { id: dynamicGuildId },
    {
      guildId: dynamicGuildId,
      channelId: dynamicChannelId,
      messageId: 'dynamic-balance-template',
      embedIndex: 0,
      source: 'system-catalog',
      title: "{dynamic}'s Balance",
      name: "{dynamic}'s Balance",
      snapshot: { title: "{dynamic}'s Balance" },
    },
    null,
    'owner',
  );
  assert.equal(preview.snapshot.title, "feelfate's Balance");
  assert.equal(preview.snapshot.description, payload.embeds[0].description);
});

test('cooldown families keep command-owned text while saved title and color stay shared', async () => {
  const cooldownGuildId = 'cooldown-family-guild';
  const cooldownChannelId = 'cooldown-family-channel';

  const catalogKey = getSystemEmbedTemplateKey(
    'embed',
    'Too fast',
    "You're doing that too quickly. Wait a moment and try again.",
    'gambling/crime',
  );
  primeSystemEmbedTemplateData(catalogKey, 'gambling/crime', {
    title: 'Too fast',
    description: "You're doing that too quickly. Wait a moment and try again.",
    color: 0xFEE75C,
  });

  const crimeRuntime = applyRuntimeEmbedTemplateData({
    title: 'Too fast',
    description: "You're in jail for 95 more minutes!",
    color: 0x7A1712,
  }, { commandName: 'crime' });
  assert.equal(crimeRuntime.description, "You're in jail for 95 more minutes!");

  await saveEmbedTemplateDecoration(
    cooldownGuildId,
    cooldownChannelId,
    ['Too fast'],
    {
      title: 'Cooldown',
      description: "You're in jail for 95 more minutes!",
      color: 0x123456,
    },
  );

  const styled = await applySavedResponsePayloadTemplates({
    embeds: [{
      title: 'Too fast',
      description: "You're tired from begging! Try again in 28 minute(s).",
      color: 0xFEE75C,
    }],
  }, {
    guildId: cooldownGuildId,
    channelId: cooldownChannelId,
    commandName: 'beg',
  });

  assert.equal(styled.embeds[0].title, 'Cooldown');
  assert.equal(styled.embeds[0].color, 0x123456);
  assert.equal(
    styled.embeds[0].description,
    "You're tired from begging! Try again in 28 minute(s).",
  );
});
