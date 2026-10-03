import test from 'node:test';
import assert from 'node:assert/strict';
import { Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import { saveEmbedTemplateDecoration, warmSavedEmbedTemplateScopes, getCachedSavedEmbedTemplateData, decorateEmbedWithSavedTemplate } from '../src/services/embedTemplateService.js';
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


test('Builder Save keeps a lowercase balance suffix for every runtime member', async () => {
  const balanceGuildId = 'balance-case-guild';
  const balanceChannelId = 'balance-case-channel';
  const original = {
    title: "feelfate's Balance",
    description: 'Here is the current financial status for feelfate.',
    color: 0xFFFFFF,
    fields: [
      { name: 'Cash', value: '$100', inline: true },
      { name: 'Bank', value: '$200 / $500', inline: true },
      { name: 'Total', value: '$300', inline: true },
    ],
  };

  const message = {
    id: 'balance-case-message',
    guildId: balanceGuildId,
    channelId: balanceChannelId,
    author: { id: 'cloudy-bot' },
    flags: { has: () => false },
    createdAt: new Date('2026-10-03T12:00:00.000Z'),
    embeds: [new Embed(original)],
  };
  const channel = {
    id: balanceChannelId,
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
    id: balanceGuildId,
    client: { user: { id: 'cloudy-bot' } },
    channels: {
      cache: new Map([[balanceChannelId, channel]]),
      fetch: async id => (id === balanceChannelId ? channel : null),
    },
  };

  const state = {
    title: "feelfate's balance",
    message: original.description,
    embedFields: original.fields,
    sideColor: 0xFFFFFF,
    showLogo: false,
    removeExistingLogo: false,
    bottomLine: null,
    mediaUrl: null,
    mediaBuffer: null,
    mediaName: null,
    modifyTarget: {
      guildId: balanceGuildId,
      channelId: balanceChannelId,
      backingChannelId: balanceChannelId,
      messageId: message.id,
      embedIndex: 0,
      source: 'modified-template',
      sourceEmbedData: original,
      templateSourceData: {
        title: "{dynamic}'s Balance",
        description: 'Here is the current financial status for {dynamic}.',
      },
      previewSourceData: original,
      catalogTitle: "{dynamic}'s Balance",
      templateMode: true,
      templateTitle: "{dynamic}'s balance",
      cachedMessage: message,
    },
  };

  const saved = await saveModifiedEmbed(guild, state);
  assert.equal(saved.ok, true);

  for (const username of ['feelfate', 'Mindzset', 'Dylano']) {
    const live = getCachedSavedEmbedTemplateData(
      balanceGuildId,
      balanceChannelId,
      {
        ...original,
        title: `${username}'s Balance`,
        description: `Here is the current financial status for ${username}.`,
      },
    ).data;
    assert.equal(live.title, `${username}'s balance`);
    assert.equal(live.description, `Here is the current financial status for ${username}.`);
  }
});

test('one Too fast Save styles every activity channel but never freezes its live body', async () => {
  const sharedGuildId = 'shared-too-fast-guild';
  const crimeChannelId = 'shared-too-fast-crime';
  const begChannelId = 'shared-too-fast-beg';
  const workChannelId = 'shared-too-fast-work';

  // Simulate an old per-channel Too fast save from before this response family
  // became shared. The new shared master must win over this stale copy.
  await saveEmbedTemplateDecoration(
    sharedGuildId,
    begChannelId,
    ['Too fast'],
    {
      title: 'Old channel cooldown',
      description: 'Old frozen body',
      color: 0x654321,
    },
  );

  const saved = await saveEmbedTemplateDecoration(
    sharedGuildId,
    crimeChannelId,
    ['Too fast'],
    {
      title: 'Slow down',
      description: "You're in jail for 95 more minutes!",
      color: 0x123456,
      footer: { text: 'Cloudy cooldown' },
      thumbnail: { url: 'https://example.com/cloudy.gif' },
      image: { url: 'https://example.com/cooldown.png' },
    },
    {
      sharedScope: true,
      applyThumbnail: true,
      applyImage: true,
    },
  );
  assert.equal(saved, true);

  await warmSavedEmbedTemplateScopes(sharedGuildId, [
    crimeChannelId,
    begChannelId,
    workChannelId,
  ]);

  const cases = [
    [crimeChannelId, "You're in jail for 41 more minutes!"],
    [begChannelId, 'You are tired from begging! Try again in 17 minute(s).'],
    [workChannelId, 'You are tired from working! Try again in 9 minute(s).'],
  ];

  for (const [runtimeChannelId, description] of cases) {
    const live = getCachedSavedEmbedTemplateData(
      sharedGuildId,
      runtimeChannelId,
      {
        title: 'Too fast',
        description,
        fields: [{ name: 'Remaining', value: 'dynamic runtime value' }],
        color: 0xFCFFA1,
      },
    ).data;

    assert.equal(live.title, 'Slow down');
    assert.equal(live.color, 0x123456);
    assert.equal(live.description, description);
    assert.equal(live.fields[0].value, 'dynamic runtime value');
    assert.equal(live.footer.text, 'Cloudy cooldown');
    assert.equal(live.thumbnail.url, 'https://example.com/cloudy.gif');
    assert.equal(live.image.url, 'https://example.com/cooldown.png');
  }
});

test('Builder Search collapses Too fast from different activity channels into one result', () => {
  const channels = ['crime-search-channel', 'beg-search-channel', 'work-search-channel'];
  const guild = {
    channels: {
      cache: new Map(channels.map((id, index) => [id, { id, name: ['crime', 'beg', 'work'][index], parent: null }])),
    },
  };
  const records = channels.map((id, index) => ({
    guildId: 'too-fast-search-guild',
    channelId: id,
    messageId: `too-fast-${index}`,
    embedIndex: 0,
    source: 'modified-template',
    title: 'Too fast',
    name: 'Too fast',
    createdAt: `2026-10-03T12:0${index}:00.000Z`,
    snapshot: {
      title: 'Too fast',
      description: [
        "You're in jail for 95 more minutes!",
        'You are tired from begging! Try again in 28 minute(s).',
        'You are tired from working! Try again in 14 minute(s).',
      ][index],
    },
  }));

  const matches = buildMatches(guild, records, 'too fast');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].document.title, 'Too fast');
});


test('canonical dynamic Balance alias beats stale member-specific aliases from older saves', async () => {
  const staleGuildId = 'stale-balance-alias-guild';
  const staleChannelId = 'stale-balance-alias-channel';
  values.set(`cloudy:embed-template:${staleGuildId}:${staleChannelId}`, {
    "dylano's balance": {
      schemaVersion: 3,
      title: "Dylano's Balance",
      description: undefined,
      applyDescription: false,
      applyFields: false,
      applyFooter: false,
      color: 0x111111,
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
    "{dynamic}'s balance": {
      schemaVersion: 3,
      title: "{dynamic}'s balance",
      description: undefined,
      applyDescription: false,
      applyFields: false,
      applyFooter: false,
      color: 0x222222,
      updatedAt: '2026-10-03T00:00:00.000Z',
    },
  });

  await warmSavedEmbedTemplateScopes(staleGuildId, [staleChannelId]);
  const live = getCachedSavedEmbedTemplateData(staleGuildId, staleChannelId, {
    title: "Dylano's Balance",
    description: 'Here is the current financial status for Dylano.',
    color: 0xFFFFFF,
  }).data;

  assert.equal(live.title, "Dylano's balance");
  assert.equal(live.color, 0x222222);
});

test('async template decoration also lets one shared Too fast save beat stale channel copies', async () => {
  const sharedGuildId = 'async-shared-too-fast-guild';
  const sharedChannelId = 'async-shared-too-fast-channel';

  await saveEmbedTemplateDecoration(
    sharedGuildId,
    sharedChannelId,
    ['Too fast'],
    {
      title: 'Old cooldown',
      description: 'Old frozen body',
      color: 0x111111,
    },
  );
  await saveEmbedTemplateDecoration(
    sharedGuildId,
    sharedChannelId,
    ['Too fast'],
    {
      title: 'Slow down',
      description: 'Example body that must stay runtime-owned',
      color: 0x334455,
      footer: { text: 'Cloudy cooldown' },
    },
    { sharedScope: true },
  );

  const decorated = await decorateEmbedWithSavedTemplate(
    sharedGuildId,
    sharedChannelId,
    new Embed({
      title: 'Too fast',
      description: 'You are tired from working! Try again in 8 minute(s).',
      color: 0xFCFFA1,
    }),
  );
  const data = decorated.embed.toJSON();

  assert.equal(data.title, 'Slow down');
  assert.equal(data.color, 0x334455);
  assert.equal(data.description, 'You are tired from working! Try again in 8 minute(s).');
  assert.equal(data.footer.text, 'Cloudy cooldown');
});
