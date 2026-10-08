import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildBuilderEmbeds } from '../src/commands/Tools/embedbuilder.js';
import {
  buildMatches as buildLiveSearchMatches,
  latestRealPreviewRecord,
  recordTitle as liveSearchRecordTitle,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { EmbedBuilder } from 'discord.js';

import { db, getFromDb, setInDb } from '../src/utils/database.js';
import {
  getEmbedRegistry,
  isRegistrableCloudyEmbedMessage,
  reconcileEmbedRegistry,
  registerCloudyEmbedMessage,
  removeEmbedRegistryMessage,
  purgeEmbedRegistryRecord,
} from '../src/services/embedRegistryService.js';
import {
  buildEmbedPayload,
  buildChannelPayload,
  canonicalBuilderResponseTitle,
  collapseDisplayRecords,
  discoverEmbedManagerOverviewRecords,
  embedManagerCheckingChannelIds,
  mergeEmbedManagerRecords,
  loadRecordSnapshotIntoState,
  openEmbedManager,
  prepareEmbedManager,
  prefersCatalogPreview,
  shouldApplyBackgroundRegistryRefresh,
  templateIdentity,
} from '../src/services/embedManagerService.js';
import {
  CLOUDY_LOGO_URL,
  isCloudyLogoUrl,
  migrateCloudyLogoEmbedData,
} from '../src/services/cloudyLogoService.js';
import {
  applyRuntimeEmbedTemplateData,
  getSystemEmbedTemplateKey,
  primeSystemEmbedTemplateData,
  primeSystemSourceDefinitionPreview,
} from '../src/services/systemEmbedCatalogService.js';
import {
  isBlackjackEmbed,
  stripBlackjackCardsRemaining,
} from '../src/utils/blackjackEmbedPresentation.js';
import {
  applyEmbedColorPickerSession,
  createEmbedColorPickerSession,
  deleteEmbedColorPickerSession,
} from '../src/services/embedColorPickerSessionService.js';
import {
  applySavedEmbedTemplates,
  decorateEmbedWithSavedTemplate,
  saveEmbedTemplateDecoration,
} from '../src/services/embedTemplateService.js';
import { fetchRecentAuditEntry } from '../src/services/recentAuditLogService.js';
import { logTicketEvent } from '../src/utils/ticket/ticketLogging.js';
import ticketLogFooterEnforcer from '../src/events/ticketLogFooterEnforcer.js';
import { applySavedBlackjackPayloadTemplates } from '../src/events/fullResponseCatalogReady.js';

function installTestStorage() {
  const values = new Map();
  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = {
    get: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
      return true;
    },
    delete: async key => values.delete(key),
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
  };
  return values;
}

function record(guildId, channelId, messageId, embedIndex, title) {
  return {
    guildId,
    channelId,
    messageId,
    embedIndex,
    // These fixtures model a custom Builder message. The registry deliberately
    // excludes random ordinary bot responses from the editable list.
    source: 'embed-builder',
    title,
    name: title,
    createdAt: '2026-08-29T20:00:00.000Z',
  };
}

function missingMessageError() {
  const error = new Error('Unknown Message');
  error.code = 10008;
  return error;
}

function buildGuild({ guildId, channelId, messages }) {
  const channel = {
    id: channelId,
    name: 'command-channel',
    type: 0,
    rawPosition: 1,
    position: 1,
    parent: null,
    toString: () => `<#${channelId}>`,
    messages: {
      fetch: async messageId => {
        if (!messages.has(messageId)) throw missingMessageError();
        return messages.get(messageId);
      },
    },
  };
  const client = { user: { id: 'cloudy-bot' } };
  return {
    id: guildId,
    client,
    members: { me: { id: 'cloudy-bot' } },
    channels: {
      cache: new Map([[channelId, channel]]),
      fetch: async id => id === channelId ? channel : null,
    },
  };
}

test('generic Builder response identity ignores cosmetic emoji/case/punctuation variants', () => {
  const channelId = '200000000000000777';
  const catalog = {
    title: '🚔 Crime Failed!',
    author: {
      name: 'Cloudy template key: embed-type:deadbeef || Cloudy context: gambling/crime || Cloudy kind: embed',
    },
  };
  const runtime = { title: 'Crime failed' };

  assert.equal(canonicalBuilderResponseTitle(catalog.title), 'crime failed');
  assert.equal(templateIdentity(channelId, catalog), templateIdentity(channelId, runtime));
});

test('unchecked channels remain selectable while saved embeds are checked', () => {
  const guildId = '100000000000000778';
  const channelId = '200000000000000778';
  const guild = buildGuild({ guildId, channelId, messages: new Map() });
  guild.channels.cache.get(channelId).type = 0;
  const checking = embedManagerCheckingChannelIds(guild, []);
  const payload = buildChannelPayload(guild, [], 0, checking);
  const option = payload.components[0].toJSON().components[0].options[0];

  assert.equal(option.description, 'Checking saved embeds…');
  assert.equal(option.value, channelId);
  assert.doesNotMatch(option.description, /No saved embed/i);
});

test('channel browser preloads once per Builder and consumes the snapshot on open', async () => {
  installTestStorage();
  const guildId = '100000000000000779';
  const channelId = '200000000000000779';
  const guild = buildGuild({ guildId, channelId, messages: new Map() });
  guild.channels.cache.get(channelId).type = 0;
  const state = {};
  prepareEmbedManager(guild, state);
  const pending = state.embedManagerPrepared;
  prepareEmbedManager(guild, state);
  assert.equal(state.embedManagerPrepared, pending);
  await pending;
  const originalGet = db.db.get;
  const reads = [];
  db.db.get = async key => { reads.push(key); return originalGet(key); };
  let firstPaintReads;
  const collector = new FakeCollector();
  await openEmbedManager({
    guild, client: guild.client, user: { id: 'owner-user' },
    deferUpdate: async () => {},
    followUp: async payload => {
      firstPaintReads = [...reads];
      assert.equal(payload.components[0].toJSON().components[0].options[0].description, 'Checking saved embeds…');
      return { id: 'preloaded-manager', createMessageComponentCollector: () => collector };
    },
    webhook: { editMessage: async () => {}, deleteMessage: async () => {} },
  }, state, async () => true);
  assert.deepEqual(firstPaintReads, [], 'first paint must not wait for another database read');
  assert.equal(state.embedManagerPrepared, undefined, 'later opens must fetch fresh records');
  collector.stop('test-complete');
  Object.assign(db.db, { get: originalGet });
});

test('renaming a catalog embed keeps its stable game template identity', () => {
  const savedCatalogEmbed = {
    title: 'My custom Blackjack title',
    author: {
      name: 'Cloudy template key: game:blackjack:bet || Cloudy context: gambling/blackjack || Cloudy kind: embed',
    },
  };

  assert.equal(
    templateIdentity('200000000000000001', savedCatalogEmbed),
    'game:blackjack:bet',
  );
});

test('the old GitHub-hosted C logo is recognized and migrated to the stable CDN URL', () => {
  const oldLogoUrl = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo-auf-auf.gif';
  const migrated = migrateCloudyLogoEmbedData({ thumbnail: { url: oldLogoUrl } });

  assert.equal(isCloudyLogoUrl(oldLogoUrl), true);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.data.thumbnail.url, CLOUDY_LOGO_URL);
  assert.match(CLOUDY_LOGO_URL, /^https:\/\/cdn\.jsdelivr\.net\//);
});

test('registry reconciliation removes deleted messages and missing embed indexes from counts', async () => {
  installTestStorage();
  const guildId = '100000000000000001';
  const channelId = '200000000000000001';
  const liveMessageId = '300000000000000001';
  const deletedMessageId = '300000000000000002';
  const registryKey = `cloudy:embed-registry:${guildId}`;

  await setInDb(registryKey, [
    record(guildId, channelId, liveMessageId, 0, 'Live embed'),
    record(guildId, channelId, liveMessageId, 1, 'Removed second embed'),
    record(guildId, channelId, deletedMessageId, 0, 'Deleted message'),
  ]);

  const messages = new Map([[
    liveMessageId,
    {
      id: liveMessageId,
      guildId,
      channelId,
      author: { id: 'cloudy-bot' },
      embeds: [{ title: 'Live embed', description: 'Still exists' }],
      createdAt: new Date('2026-08-29T20:00:00.000Z'),
    },
  ]]);
  const guild = buildGuild({ guildId, channelId, messages });

  const result = await reconcileEmbedRegistry(guild);
  const payload = buildChannelPayload(guild, result.records);

  assert.equal(result.records.length, 1);
  assert.equal(result.removedRecords, 2);
  assert.match(payload.embeds[0].toJSON().description, /\*\*Embeds found:\*\* 1/);
  const channelOption = payload.components[0].toJSON().components[0].options[0];
  assert.equal(channelOption.label, '# command-channel');
  assert.equal(channelOption.description, 'Open the saved embed');
  assert.equal((await getFromDb(registryKey, [])).length, 1);
});

test('message deletion removes every embed index for that message', async () => {
  installTestStorage();
  const guildId = '100000000000000002';
  const channelId = '200000000000000002';
  const messageId = '300000000000000003';
  const otherMessageId = '300000000000000004';
  const registryKey = `cloudy:embed-registry:${guildId}`;

  await setInDb(registryKey, [
    record(guildId, channelId, messageId, 0, 'First'),
    record(guildId, channelId, messageId, 1, 'Second'),
    record(guildId, channelId, otherMessageId, 0, 'Keep'),
  ]);

  await removeEmbedRegistryMessage(guildId, channelId, messageId);
  const remaining = await getFromDb(registryKey, []);

  assert.deepEqual(remaining.map(item => item.messageId), [otherMessageId]);
});

test('private builder previews and command replies never enter the editable embed registry', async () => {
  installTestStorage();
  const guildId = '100000000000000009';
  const channelId = '200000000000000009';
  const base = {
    id: '300000000000000009',
    guildId,
    channelId,
    embeds: [{ title: 'User preview' }],
    createdAt: new Date('2026-08-29T20:00:00.000Z'),
  };

  const ephemeralPreview = {
    ...base,
    flags: { has: flag => flag === 64 },
  };
  const publicCommandReply = {
    ...base,
    id: '300000000000000010',
    flags: { has: () => false },
    interactionMetadata: { id: '400000000000000009' },
  };

  assert.equal(isRegistrableCloudyEmbedMessage(ephemeralPreview), false);
  assert.equal(isRegistrableCloudyEmbedMessage(publicCommandReply), false);
  assert.equal(await registerCloudyEmbedMessage(ephemeralPreview, 'automatic'), false);
  assert.equal(await registerCloudyEmbedMessage(publicCommandReply, 'automatic'), false);
  assert.deepEqual(await getEmbedRegistry(guildId), []);
});

test('emoji editor preserves animated emoji data and keeps only the latest live field update', async () => {
  const updates = [];
  const token = createEmbedColorPickerSession({
    userId: 'owner-user',
    emojis: [{ id: '400000000000000001', name: 'cloudy_wave', animated: true }],
    getEditorState: () => ({
      title: 'Hello',
      message: 'World',
      footer: 'Footer',
      fields: [{ name: 'Rule', value: 'Be respectful', inline: false }],
    }),
    onEditorUpdate: async (field, value) => updates.push({ field, value }),
    onColor: async () => {},
  });

  const state = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__');
  const statePayload = JSON.parse(state.color);
  assert.deepEqual(statePayload.emojis, [
    { id: '400000000000000001', name: 'cloudy_wave', animated: true },
  ]);
  assert.deepEqual(statePayload.fields, [
    { name: 'Rule', value: 'Be respectful', inline: false },
  ]);

  const markup = '<a:cloudy_wave:400000000000000001>';
  const update = await applyEmbedColorPickerSession(
    token,
    `__CLOUDY_EMBED_EDIT__:${JSON.stringify({ field: 'message', value: `Hi ${markup}` })}`,
  );
  const latestUpdate = await applyEmbedColorPickerSession(
    token,
    `__CLOUDY_EMBED_EDIT__:${JSON.stringify({ field: 'message', value: `Latest ${markup}` })}`,
  );

  assert.equal(update.ok, true);
  assert.equal(latestUpdate.ok, true);
  await new Promise(resolve => { setTimeout(resolve, 10); });
  assert.deepEqual(updates, [{ field: 'message', value: `Latest ${markup}` }]);

  const fieldUpdate = await applyEmbedColorPickerSession(
    token,
    `__CLOUDY_EMBED_EDIT__:${JSON.stringify({ field: 'embed_field_value:0', value: `Updated ${markup}` })}`,
  );
  assert.equal(fieldUpdate.ok, true);
  await new Promise(resolve => { setTimeout(resolve, 10); });
  assert.deepEqual(updates.at(-1), { field: 'embed_field_value:0', value: `Updated ${markup}` });
  deleteEmbedColorPickerSession(token);
  assert.equal((await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__')).reason, 'expired');
});

class FakeCollector extends EventEmitter {
  ended = false;

  stop(reason) {
    if (this.ended) return;
    this.ended = true;
    this.emit('end', [], reason);
  }
}

test('Builder preview hides internal template metadata while showing live dynamic values', () => {
  const state = {
    title: 'Cloudy Fix Guide',
    message: 'Owner: Dylano',
    sideColor: 0x5865F2,
    showLogo: false,
    removeExistingLogo: false,
    bottomLine: null,
    mediaBuffer: null,
    mediaName: null,
    mediaUrl: null,
    mediaConvertedFromVideo: false,
    embedFields: [],
    modifyTarget: {
      sourceEmbedData: {
        title: 'Cloudy Fix Guide',
        description: 'Owner: {dynamic}',
        author: {
          name: 'Cloudy template key: source:e8ffec87 || Cloudy context: faq/faq-ai-interaction || Cloudy kind: content',
        },
      },
    },
  };

  const [preview] = buildBuilderEmbeds(state);
  const data = preview.toJSON();

  assert.equal(data.title, 'Cloudy Fix Guide');
  assert.equal(data.description, 'Owner: Dylano');
  assert.equal(data.author, undefined);
});

test('Builder Search uses human names and preserves semantically different live text', () => {
  const channel = {
    id: '200000000000000099',
    name: 'faq',
    parent: null,
  };
  const guild = { channels: { cache: new Map([[channel.id, channel]]) } };
  const catalog = key => ({
    guildId: '100000000000000099',
    channelId: channel.id,
    backingChannelId: '900000000000000099',
    messageId: `catalog-${key}`,
    embedIndex: 0,
    source: 'system-catalog',
    name: `source:${key}`,
    title: `source:${key}`,
    createdAt: '2026-10-02T14:00:00.000Z',
    snapshot: {
      title: `source:${key}`,
      description: 'This FAQ assistant can only be used in the FAQ channel.',
      author: {
        name: `Cloudy template key: source:${key} || Cloudy context: faq/faq-ai-interaction || Cloudy kind: content`,
      },
    },
  });
  const real = {
    guildId: '100000000000000099',
    channelId: channel.id,
    messageId: 'real-faq',
    embedIndex: 0,
    source: 'modified-template',
    name: 'This FAQ assistant can only be used in the FAQ channel.',
    title: 'This FAQ assistant can only be used in the FAQ channel.',
    createdAt: '2026-10-02T14:02:00.000Z',
    snapshot: {
      title: 'This FAQ assistant can only be used in the FAQ channel.',
      description: 'Owner: Dylano',
    },
  };

  const records = [catalog('e8ffec87'), catalog('ab12cd34'), real];
  const matches = buildLiveSearchMatches(guild, records, 'faq assistant');

  assert.equal(matches.length, 3);
  assert.equal(matches[0].document.title, 'This FAQ assistant can only be used in the FAQ channel.');
  assert.deepEqual(new Set(matches.map(match => match.record.messageId)), new Set(records.map(record => record.messageId)));
  assert.equal(/source:|bot code|cloudy template key/i.test(matches[0].document.title), false);
  assert.equal(liveSearchRecordTitle(records[0]), 'This FAQ assistant can only be used in the FAQ channel.');
  assert.equal(latestRealPreviewRecord(guild, records, matches[0].record)?.messageId, 'real-faq');
});

test('Builder Search keeps the canonical casino master ahead of distinct runtime text', () => {
  const channel = {
    id: '200000000000000090',
    name: 'gambling',
    parent: null,
  };
  const guild = { channels: { cache: new Map([[channel.id, channel]]) } };
  const records = [
    {
      guildId: '100000000000000090',
      channelId: channel.id,
      backingChannelId: '900000000000000090',
      messageId: 'catalog-blackjack-loss',
      embedIndex: 0,
      source: 'system-catalog',
      title: 'Blackjack loss',
      name: 'Blackjack loss',
      createdAt: '2026-10-02T18:00:00.000Z',
      snapshot: {
        title: 'Blackjack loss',
        author: {
          name: 'Cloudy template key: game:blackjack:result:loss || Cloudy context: gambling/blackjack || Cloudy kind: embed',
        },
      },
    },
    {
      guildId: '100000000000000090',
      channelId: channel.id,
      messageId: 'real-blackjack-loss',
      embedIndex: 0,
      source: 'modified-template',
      title: 'Blackjack loss',
      name: 'Blackjack loss',
      createdAt: '2026-10-02T18:01:00.000Z',
      snapshot: {
        title: 'Blackjack loss',
        description: 'Live cards and cash values',
      },
    },
  ];

  const matches = buildLiveSearchMatches(guild, records, 'blackjack loss');
  assert.equal(matches.length, 2);
  assert.equal(matches[0].record.messageId, 'catalog-blackjack-loss');
  assert.equal(matches[1].record.messageId, 'real-blackjack-loss');
});

test('Builder Search resolves legacy Success alias to Robbery successful', () => {
  primeSystemSourceDefinitionPreview({
    kind: 'embed',
    context: 'gambling/rob',
    title: 'Robbery successful',
    description: 'You successfully stole **{dynamic}** from {dynamic}!',
    color: 0x00C49D,
    fields: [
      { name: 'Your new cash ({dynamic})', value: '{dynamic}', inline: true },
      { name: "Victim's new cash ({dynamic})", value: '{dynamic}', inline: true },
    ],
    footer: { text: 'Next robbery available in {dynamic} hours.' },
  });

  const channel = {
    id: '200000000000000088',
    name: 'gambling',
    parent: null,
  };
  const guild = {
    id: '100000000000000088',
    channels: { cache: new Map([[channel.id, channel]]) },
  };
  const records = [{
    guildId: guild.id,
    channelId: channel.id,
    backingChannelId: '900000000000000088',
    messageId: '300000000000000088',
    embedIndex: 0,
    source: 'system-catalog',
    title: 'Success',
    name: 'Success',
    createdAt: '2026-10-02T18:20:00.000Z',
    snapshot: {
      title: 'Success',
      description: 'Robbery successful',
      color: 0x00C49D,
      author: {
        name: 'Cloudy template key: embed:legacyrob || Cloudy context: gambling/rob || Cloudy kind: embed',
      },
    },
  }];

  const matches = buildLiveSearchMatches(guild, records, 'robbery successful');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].document.title, 'Robbery successful');
  assert.equal(matches[0].record.title, 'Robbery successful');
  assert.equal(
    matches[0].record.snapshot.description,
    'You successfully stole **{dynamic}** from {dynamic}!',
  );
  assert.equal(matches[0].record.snapshot.fields.length, 2);
  assert.equal(matches[0].record.snapshot.footer.text, 'Next robbery available in {dynamic} hours.');
});

test('Modify browser loads full dynamic source data with sparse live previews', () => {
  const channel = {
    id: '200000000000000089',
    name: 'gambling',
    parent: null,
  };
  const guild = {
    id: '100000000000000089',
    channels: { cache: new Map([[channel.id, channel]]) },
  };

  const makeCatalog = (messageId, title, description, fields) => ({
    guildId: guild.id,
    channelId: channel.id,
    backingChannelId: '900000000000000089',
    messageId,
    embedIndex: 0,
    source: 'system-catalog',
    title,
    name: title,
    createdAt: '2026-10-02T18:10:00.000Z',
    snapshot: {
      title,
      description,
      fields,
      author: {
        name: `Cloudy template key: embed:${messageId} || Cloudy context: gambling/rob || Cloudy kind: embed`,
      },
      color: 0xFFFFFF,
    },
  });
  const makeSparseLive = (messageId, title, minute) => ({
    guildId: guild.id,
    channelId: channel.id,
    messageId,
    embedIndex: 0,
    source: 'modified-template',
    title,
    name: title,
    createdAt: `2026-10-02T18:${minute}:00.000Z`,
    snapshot: {
      title,
      color: 0xFFFFFF,
    },
  });

  const records = [
    makeCatalog(
      'catalog-rob-success',
      'Robbery successful',
      'You successfully stole **{dynamic}** from {dynamic}!',
      [
        { name: 'Your new cash ({dynamic})', value: '{dynamic}', inline: true },
        { name: "Victim's new cash ({dynamic})", value: '{dynamic}', inline: true },
      ],
    ),
    makeSparseLive('real-rob-success', 'Robbery successful', '11'),
    makeCatalog(
      'catalog-rob-failed',
      'Robbery failed',
      'You failed the robbery and were caught! You were fined **{dynamic}** of your own cash.',
      [
        { name: 'Your new cash ({dynamic})', value: '{dynamic}', inline: true },
        { name: "Victim's new cash ({dynamic})", value: '{dynamic}', inline: true },
      ],
    ),
    makeSparseLive('real-rob-failed', 'Robbery failed', '12'),
  ];

  for (const [query, expectedCatalogId, expectedPreviewId, expectedDescription] of [
    ['robbery successful', 'catalog-rob-success', 'real-rob-success', 'You successfully stole **{dynamic}** from {dynamic}!'],
    ['robbery failed', 'catalog-rob-failed', 'real-rob-failed', 'You failed the robbery and were caught! You were fined **{dynamic}** of your own cash.'],
  ]) {
    const matches = buildLiveSearchMatches(guild, collapseDisplayRecords(records, channel.id), query);
    assert.equal(matches.length, 1, query);

    const record = matches[0].record;
    assert.equal(record.messageId, expectedCatalogId, query);
    assert.ok(record.previewRecord, query);
    assert.equal(record.previewRecord.messageId, expectedPreviewId, query);
    assert.ok(record.sourceRecord, query);
    assert.match(record.sourceRecord.messageId, /^catalog-rob-/, query);

    const state = {};
    assert.equal(loadRecordSnapshotIntoState(
      state,
      guild,
      record,
      record.previewRecord || null,
      record.sourceRecord || null,
    ), true, query);

    assert.equal(state.message, expectedDescription, query);
    assert.equal(state.embedFields.length, 2, query);
    assert.match(state.embedFields[0].name, /\{dynamic\}/, query);
    assert.equal(state.modifyTarget.messageId, expectedCatalogId, query);
  }
});

test('sparse catalog template preview falls back to the full source embed without changing its Save target', async () => {
  installTestStorage();

  const guildId = '100000000000000098';
  const channelId = '200000000000000098';
  const messageId = '300000000000000098';
  const description = [
    'Have a question or need help with something?',
    '',
    'Our AI Assistant can help you find answers to common questions, server information, features, commands, and more.',
    '',
    'You can ask your question in any language, and you’ll receive a response in the same language.',
    '',
    'Click **Ask a question** below and let Cloudy Inc. assist you.',
  ].join('\n');

  primeSystemSourceDefinitionPreview({
    kind: 'embed',
    title: 'Cloudy Support Assistant',
    description,
    context: 'faq/faq-ai-service',
    variantId: 'services/faqAiService.js:embed:test',
  });

  const sparseMessage = {
    id: messageId,
    guildId,
    channelId,
    embeds: [{
      title: 'Cloudy Support Assistant',
      color: 0x5865F2,
      author: {
        name: 'Cloudy template key: embed:test || Cloudy context: faq/faq-ai-service || Cloudy kind: embed',
      },
    }],
    createdAt: new Date('2026-10-02T15:00:00.000Z'),
  };

  assert.equal(await registerCloudyEmbedMessage(sparseMessage, 'embed-builder'), true);
  const [stored] = await getEmbedRegistry(guildId);
  const record = { ...stored, source: 'system-catalog' };
  const state = {};

  assert.equal(loadRecordSnapshotIntoState(state, { id: guildId }, record), true);
  assert.equal(state.title, 'Cloudy Support Assistant');
  assert.equal(state.message, description);
  assert.equal(state.modifyTarget.sourceEmbedData.description, undefined);
  assert.equal(state.modifyTarget.previewSourceData.description, description);
});

test('title-only live peer cannot hide full source text from the Builder live preview', async () => {
  installTestStorage();

  const guildId = '100000000000000097';
  const channelId = '200000000000000097';
  const description = [
    'Have a question or need help with something?',
    '',
    'Our AI Assistant can help you find answers to common questions, server information, features, commands, and more.',
    '',
    'You can ask your question in any language, and you’ll receive a response in the same language.',
    '',
    'Click **Ask a question** below and let Cloudy Inc. assist you.',
  ].join('\n');

  primeSystemSourceDefinitionPreview({
    kind: 'embed',
    title: 'Cloudy Support Assistant',
    description,
    context: 'faq/faq-ai-service',
    variantId: 'services/faqAiService.js:embed:title-only-peer-test',
  });

  const catalogMessage = {
    id: '300000000000000097',
    guildId,
    channelId,
    embeds: [{
      title: 'Cloudy Support Assistant',
      color: 0x5865F2,
      author: {
        name: 'Cloudy template key: embed:test || Cloudy context: faq/faq-ai-service || Cloudy kind: embed',
      },
    }],
    createdAt: new Date('2026-10-02T15:00:00.000Z'),
  };
  const sparsePeerMessage = {
    id: '300000000000000096',
    guildId,
    channelId,
    embeds: [{
      title: 'Cloudy Support Assistant',
      color: 0x5865F2,
    }],
    createdAt: new Date('2026-10-02T15:01:00.000Z'),
  };

  assert.equal(await registerCloudyEmbedMessage(catalogMessage, 'embed-builder'), true);
  assert.equal(await registerCloudyEmbedMessage(sparsePeerMessage, 'embed-builder'), true);
  const records = await getEmbedRegistry(guildId);
  const catalogRecord = { ...records.find(record => record.messageId === catalogMessage.id), source: 'system-catalog' };
  const previewRecord = records.find(record => record.messageId === sparsePeerMessage.id);
  const state = {};

  assert.equal(loadRecordSnapshotIntoState(state, { id: guildId }, catalogRecord, previewRecord), true);
  assert.equal(state.message, description);
  assert.equal(state.modifyTarget.previewSourceData.description, description);

  const [preview] = buildBuilderEmbeds(state);
  assert.equal(preview.toJSON().description, description);
});

test('Builder finds the complete source body when catalog and source use sibling FAQ contexts', async () => {
  installTestStorage();

  const guildId = '100000000000000095';
  const channelId = '200000000000000095';
  const description = [
    'Have a question or need help with something?',
    '',
    'Our AI Assistant can help you find answers to common questions, server information, features, commands, and more.',
    '',
    'You can ask your question in any language, and you’ll receive a response in the same language.',
    '',
    'Click **Ask a question** below and let Cloudy Inc. assist you.',
  ].join('\n');

  primeSystemSourceDefinitionPreview({
    kind: 'embed',
    title: 'Cloudy Support Assistant',
    description,
    context: 'faq/faq-ai-service',
    variantId: 'services/faqAiService.js:embed:sibling-context-test',
  });

  const sparseMessage = {
    id: '300000000000000095',
    guildId,
    channelId,
    embeds: [{
      title: 'Cloudy Support Assistant',
      color: 0xFFFFFF,
      author: {
        name: 'Cloudy template key: embed:sibling-test || Cloudy context: faq/faq-ai-interaction || Cloudy kind: embed',
      },
    }],
    createdAt: new Date('2026-10-02T16:00:00.000Z'),
  };

  assert.equal(await registerCloudyEmbedMessage(sparseMessage, 'embed-builder'), true);
  const [stored] = await getEmbedRegistry(guildId);
  const state = {};

  assert.equal(loadRecordSnapshotIntoState(
    state,
    { id: guildId },
    { ...stored, source: 'system-catalog' },
  ), true);
  assert.equal(state.message, description);

  const [preview] = buildBuilderEmbeds(state);
  assert.equal(preview.toJSON().description, description);
});

test('registry persists the complete manual Builder snapshot instead of only its title', async () => {
  installTestStorage();

  const guildId = '100000000000000094';
  const channelId = '200000000000000094';
  const messageId = '300000000000000094';
  const description = 'Rules body that must survive restarts and Discord deletion.';
  const message = {
    id: messageId,
    guildId,
    channelId,
    channel: { name: 'rules' },
    embeds: [{
      title: 'Rules',
      description,
      fields: [{ name: 'Respect', value: 'Keep it civil.', inline: false }],
      footer: { text: 'Cloudy rules' },
      color: 0xFFFFFF,
    }],
    createdAt: new Date('2026-10-02T17:00:00.000Z'),
  };

  assert.equal(await registerCloudyEmbedMessage(message, 'embed-builder'), true);

  const stored = await getFromDb(`cloudy:embed-registry:${guildId}`, []);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].snapshot.title, 'Rules');
  assert.equal(stored[0].snapshot.description, description);
  assert.equal(stored[0].snapshot.fields[0].value, 'Keep it civil.');
  assert.equal(stored[0].channelName, 'rules');
});

test('deleted manual Builder embeds stay as detached saved templates with their full body', async () => {
  installTestStorage();

  const guildId = '100000000000000093';
  const channelId = '200000000000000093';
  const messageId = '300000000000000093';
  const description = 'Persistent Rules text';
  const message = {
    id: messageId,
    guildId,
    channelId,
    channel: { name: 'rules' },
    embeds: [{ title: 'Rules', description, color: 0xFFFFFF }],
    createdAt: new Date('2026-10-02T17:01:00.000Z'),
  };

  assert.equal(await registerCloudyEmbedMessage(message, 'embed-builder'), true);
  assert.equal(await removeEmbedRegistryMessage(guildId, channelId, messageId), true);

  const [stored] = await getEmbedRegistry(guildId);
  assert.equal(stored.detached, true);
  assert.equal(stored.snapshot.title, 'Rules');
  assert.equal(stored.snapshot.description, description);
});

test('detached snapshots remain loadable but stay out of the live channel browser', () => {
  const guildId = '100000000000000092';
  const record = {
    guildId,
    channelId: 'deleted-rules-channel',
    backingChannelId: null,
    messageId: 'deleted-rules-message',
    embedIndex: 0,
    source: 'embed-builder',
    title: 'Rules',
    name: 'Rules',
    channelName: 'rules',
    detached: true,
    createdAt: '2026-10-02T17:02:00.000Z',
    snapshot: {
      title: 'Rules',
      description: 'Full Rules text from the durable snapshot.',
      color: 0xFFFFFF,
    },
  };
  const guild = {
    id: guildId,
    channels: { cache: new Map() },
  };

  const channelPayload = buildChannelPayload(guild, [record]);
  assert.equal(channelPayload.components.length, 0);
  assert.match(channelPayload.embeds[0].toJSON().description, /\*\*Channels:\*\* 0/);
  assert.deepEqual(buildLiveSearchMatches(guild, [record], 'rules'), []);

  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, guild, record), true);
  assert.equal(state.title, 'Rules');
  assert.equal(state.message, 'Full Rules text from the durable snapshot.');
  assert.equal(state.modifyTarget.detached, true);

  const [preview] = buildBuilderEmbeds(state);
  assert.equal(preview.toJSON().description, 'Full Rules text from the durable snapshot.');
});

test('background registry refresh stops as soon as manager interaction begins', () => {
  const session = { closed: false, hasInteracted: false };
  const state = { activeEmbedManager: session };

  assert.equal(shouldApplyBackgroundRegistryRefresh(state, session), true);

  session.hasInteracted = true;
  assert.equal(shouldApplyBackgroundRegistryRefresh(state, session), false);

  session.hasInteracted = false;
  session.closed = true;
  assert.equal(shouldApplyBackgroundRegistryRefresh(state, session), false);

  session.closed = false;
  state.activeEmbedManager = {};
  assert.equal(shouldApplyBackgroundRegistryRefresh(state, session), false);
});

test('embed manager overview live-hydrates channels before showing them as empty', async () => {
  installTestStorage();
  const guildId = '100000000000000099';
  const channelId = '200000000000000099';
  const messageId = '300000000000000099';
  const liveMessage = {
    id: messageId,
    guildId,
    channelId,
    author: { id: 'cloudy-bot' },
    embeds: [{ title: 'Already saved', description: 'This embed is live in Discord.' }],
    components: [],
    createdAt: new Date('2026-10-03T04:00:00.000Z'),
    createdTimestamp: Date.parse('2026-10-03T04:00:00.000Z'),
  };
  const batch = new Map([[messageId, liveMessage]]);
  batch.last = () => liveMessage;
  const channel = {
    id: channelId,
    type: 0,
    name: 'already-saved',
    rawPosition: 1,
    position: 1,
    parent: null,
    toString: () => `<#${channelId}>`,
    messages: {
      cache: new Map(),
      fetch: async options => {
        assert.deepEqual(options, { limit: 100 });
        return batch;
      },
    },
  };
  const guild = {
    id: guildId,
    client: { user: { id: 'cloudy-bot' } },
    members: { me: { id: 'cloudy-bot' } },
    channels: {
      cache: new Map([[channelId, channel]]),
      fetch: async id => id === channelId ? channel : null,
    },
  };

  const discovered = await discoverEmbedManagerOverviewRecords(guild, [], 'cloudy-bot');
  const records = mergeEmbedManagerRecords([], discovered);
  const payload = buildChannelPayload(guild, records);
  const option = payload.components[0].toJSON().components[0].options[0];

  assert.equal(discovered.length, 1);
  assert.equal(option.label, '# already-saved');
  assert.equal(option.description, 'Open the saved embed');
  assert.doesNotMatch(option.description, /No saved embed/i);
});

test('embed manager navigation edits through the fresh component interaction', async () => {
  installTestStorage();
  const guildId = '100000000000000003';
  const channelId = '200000000000000003';
  const messageId = '300000000000000005';
  await setInDb(`cloudy:embed-registry:${guildId}`, [
    record(guildId, channelId, messageId, 0, 'Editable embed'),
  ]);

  const messages = new Map([[
    messageId,
    {
      id: messageId,
      guildId,
      channelId,
      author: { id: 'cloudy-bot' },
      embeds: [{ title: 'Editable embed', description: 'Content' }],
      createdAt: new Date('2026-08-29T20:00:00.000Z'),
    },
  ]]);
  const guild = buildGuild({ guildId, channelId, messages });
  guild.channels.cache.get(channelId).permissionsFor = () => ({ has: () => true });
  const collector = new FakeCollector();
  const managerMessage = {
    id: 'manager-message',
    createMessageComponentCollector: () => collector,
  };
  let initialPayload = null;
  const buttonInteraction = {
    guild,
    client: guild.client,
    user: { id: 'owner-user' },
    member: { id: 'owner-user' },
    deferUpdate: async () => {},
    followUp: async payload => {
      initialPayload = payload;
      return managerMessage;
    },
    webhook: {
      deleteMessage: async () => {},
    },
  };
  const state = {};

  await openEmbedManager(buttonInteraction, state, async () => true);
  assert.match(initialPayload.embeds[0].toJSON().description, /Choose a channel first/);
  assert.equal(initialPayload.components.length, 1);
  assert.ok(state.activeEmbedManager);

  let navigationPayload = null;
  let navigationFinished;
  const finished = new Promise(resolve => {
    navigationFinished = resolve;
  });
  collector.emit('collect', {
    user: { id: 'owner-user' },
    member: { id: 'owner-user' },
    customId: 'simple_embed_modify_channel:0',
    values: [channelId],
    deferred: false,
    replied: false,
    isStringSelectMenu: () => true,
    deferUpdate: async function deferUpdate() {
      this.deferred = true;
    },
    editReply: async payload => {
      navigationPayload = payload;
      navigationFinished();
    },
  });

  await finished;
  assert.match(navigationPayload.embeds[0].toJSON().description, /\*\*Embeds:\*\* 1/);
  collector.stop('test-complete');
});

test('embed manager opens before Discord history reconciliation finishes', async () => {
  installTestStorage();
  const guildId = '100000000000000004';
  const channelId = '200000000000000004';
  const messageId = '300000000000000006';
  await setInDb(`cloudy:embed-registry:${guildId}`, [
    record(guildId, channelId, messageId, 0, 'Immediate embed'),
  ]);

  let finishFetch;
  const pendingFetch = new Promise(resolve => {
    finishFetch = resolve;
  });
  const guild = buildGuild({ guildId, channelId, messages: new Map() });
  guild.channels.cache.get(channelId).messages.fetch = async () => pendingFetch;

  const collector = new FakeCollector();
  const managerMessage = {
    id: 'immediate-manager-message',
    createMessageComponentCollector: () => collector,
  };
  let initialPayload = null;
  const buttonInteraction = {
    guild,
    client: guild.client,
    user: { id: 'owner-user' },
    deferUpdate: async () => {},
    followUp: async payload => {
      initialPayload = payload;
      return managerMessage;
    },
    webhook: {
      deleteMessage: async () => {},
      editMessage: async () => {},
    },
  };
  const state = {};

  await openEmbedManager(buttonInteraction, state, async () => true);
  assert.match(initialPayload.embeds[0].toJSON().description, /Choose a channel first/);
  assert.ok(state.activeEmbedManager);

  finishFetch({
    id: messageId,
    guildId,
    channelId,
    author: { id: 'cloudy-bot' },
    embeds: [{ title: 'Immediate embed' }],
    createdAt: new Date('2026-08-29T20:00:00.000Z'),
  });
  collector.stop('test-complete');
});

test('saved template is applied before send and does not cause a second edit', async () => {
  installTestStorage();
  const guildId = '100000000000000005';
  const channelId = '200000000000000005';
  const dynamicThumbnail = 'https://cdn.discordapp.com/avatars/dynamic.png';

  await saveEmbedTemplateDecoration(
    guildId,
    channelId,
    ['Ban log'],
    {
      title: 'Ban log',
      color: 0x123456,
      footer: { text: 'Saved footer' },
    },
  );

  const source = new EmbedBuilder()
    .setTitle('Ban log')
    .setDescription('**User:** Dynamic user')
    .setColor(0xED4245)
    .setThumbnail(dynamicThumbnail)
    .setTimestamp();
  const decorated = await decorateEmbedWithSavedTemplate(guildId, channelId, source);

  assert.equal(decorated.matched, true);
  assert.equal(decorated.changed, true);
  assert.equal(decorated.embed.toJSON().color, 0x123456);
  assert.equal(decorated.embed.toJSON().footer.text, 'Saved footer');
  assert.equal(decorated.embed.toJSON().description, '**User:** Dynamic user');
  assert.equal(decorated.embed.toJSON().thumbnail.url, dynamicThumbnail);

  let editCount = 0;
  const alreadyDecoratedMessage = {
    guildId,
    channelId,
    editable: true,
    embeds: [decorated.embed],
    edit: async () => {
      editCount += 1;
    },
  };
  assert.equal(await applySavedEmbedTemplates(alreadyDecoratedMessage), true);
  assert.equal(editCount, 0);
});

test('ticket logs use the saved template before send and keep its footer', async () => {
  installTestStorage();
  const guildId = '100000000000000012';
  const channelId = '200000000000000012';
  let sentPayload = null;

  await saveEmbedTemplateDecoration(
    guildId,
    channelId,
    ['Ticket created'],
    {
      title: 'Ticket created',
      color: 0x123456,
      footer: { text: 'Saved ticket footer' },
      fields: [
        { name: 'Ticket', value: '#{dynamic}', inline: true },
        { name: 'Creator', value: 'Unknown', inline: true },
        { name: 'Channel', value: '<#{dynamic}>', inline: true },
      ],
    },
  );

  const channel = {
    id: channelId,
    type: 0,
    isSendable: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async payload => {
      sentPayload = payload;
      return { id: 'ticket-log-message' };
    },
  };
  const client = {
    user: { id: 'cloudy-bot' },
    db: {
      get: async () => ({ ticketLogsChannelId: channelId }),
      isAvailable: () => true,
    },
    guilds: {
      cache: new Map(),
      fetch: async id => id === guildId ? guild : null,
    },
  };
  const guild = {
    id: guildId,
    client,
    members: { me: { id: 'cloudy-bot' }, cache: new Map(), fetch: async () => null },
    channels: {
      cache: new Map([[channelId, channel]]),
      fetch: async id => id === channelId ? channel : null,
    },
  };
  client.guilds.cache.set(guildId, guild);

  const logged = await logTicketEvent({
    client,
    guildId,
    event: {
      type: 'open',
      ticketId: '300000000000000012',
      ticketNumber: 77,
    },
  });

  assert.equal(logged, true);
  const sentEmbed = sentPayload.embeds[0].toJSON();
  assert.equal(sentEmbed.color, 0x123456);
  assert.equal(sentEmbed.footer.text, 'Saved ticket footer');
  assert.equal(sentEmbed.fields[0].value, '#77');

  let editCount = 0;
  await ticketLogFooterEnforcer.execute({
    id: 'ticket-log-message',
    guild,
    guildId,
    channelId,
    author: { id: 'cloudy-bot' },
    editable: true,
    embeds: sentPayload.embeds,
    components: [],
    edit: async () => { editCount += 1; },
  }, client);
  assert.equal(editCount, 0);
});

test('game and ticket template collections prefer catalog previews', () => {
  const catalogRecord = id => ({
    source: 'system-catalog',
    messageId: id,
  });

  assert.equal(prefersCatalogPreview([catalogRecord('1'), catalogRecord('2')]), true);
  assert.equal(prefersCatalogPreview([{ source: 'embed-builder', messageId: '3' }]), false);
});

test('casino template identities ignore dynamic bets but keep result states separate', () => {
  const blackjackBet = getSystemEmbedTemplateKey(
    'embed',
    'Blackjack — Bet $10',
    '',
    'gambling/blackjack',
  );
  const blackjackBetLater = getSystemEmbedTemplateKey(
    'embed',
    'Blackjack — Bet $100',
    '',
    'gambling/blackjack',
  );

  assert.equal(blackjackBet, 'game:blackjack:bet');
  assert.equal(blackjackBetLater, blackjackBet);
  assert.equal(
    getSystemEmbedTemplateKey('embed', 'Result: Loss', 'Payout: **$0**', 'gambling/blackjack'),
    'game:blackjack:result:loss',
  );
  assert.equal(
    getSystemEmbedTemplateKey('embed', 'Result: Win', 'Payout: **$20**', 'gambling/blackjack'),
    'game:blackjack:result:win',
  );
});

test('a saved Blackjack Win template is authoritative on the next runtime result', () => {
  primeSystemEmbedTemplateData(
    'game:blackjack:result:win',
    'gambling/blackjack',
    {
      title: 'Saved Blackjack Win',
      description: 'Payout: **$20**\nCash balance: **$120**',
      color: 0x123456,
      fields: [
        { name: 'Your Hand', value: '<:ten:400000000000000020> <:king:400000000000000021>\nValue: **20**', inline: true },
        { name: 'Dealer Hand', value: '<:nine:400000000000000018> <:nine:400000000000000019>\nValue: **18**', inline: true },
      ],
    },
  );

  const rendered = applyRuntimeEmbedTemplateData({
    title: 'Result: Win',
    description: 'Payout: **$44**\nCash balance: **$144**',
    color: 0x57F287,
    fields: [
      { name: 'Your Hand', value: '<:ace:500000000000000021> <:king:500000000000000022>\nValue: **21**', inline: true },
      { name: 'Dealer Hand', value: '<:ten:500000000000000019> <:nine:500000000000000020>\nValue: **19**', inline: true },
    ],
  }, { commandName: 'blackjack' });

  assert.equal(rendered.title, 'Saved Blackjack Win');
  assert.equal(rendered.color, 0x123456);
  assert.equal(rendered.description, 'Payout: **$44**\nCash balance: **$144**');
  assert.equal(rendered.fields[0].value, '<:ace:500000000000000021> <:king:500000000000000022>\nValue: **21**');
});

test('an already persisted Blackjack Win channel template is applied before the component update', async () => {
  installTestStorage();
  const guildId = '100000000000000013';
  const channelId = '200000000000000013';

  await saveEmbedTemplateDecoration(
    guildId,
    channelId,
    ['Result: Win', 'Old Blackjack Win'],
    {
      title: 'Saved Blackjack Win',
      description: 'Payout: **$20**\nCash balance: **$120**',
      color: 0x654321,
      fields: [
        { name: 'Your Hand', value: '<:ten:400000000000000020> <:king:400000000000000021>\nValue: **20**', inline: true },
        { name: 'Dealer Hand', value: '<:nine:400000000000000018> <:nine:400000000000000019>\nValue: **18**', inline: true },
      ],
    },
  );

  const payload = await applySavedBlackjackPayloadTemplates({
    embeds: [new EmbedBuilder({
      title: 'Result: Win',
      description: 'Payout: **$60**\nCash balance: **$160**',
      color: 0x57F287,
      fields: [
        { name: 'Your Hand', value: '<:ace:500000000000000021> <:king:500000000000000022>\nValue: **21**', inline: true },
        { name: 'Dealer Hand', value: '<:ten:500000000000000019> <:nine:500000000000000020>\nValue: **19**', inline: true },
      ],
    })],
  }, { commandName: 'blackjack', guildId, channelId });

  const rendered = payload.embeds[0].toJSON();
  assert.equal(rendered.title, 'Saved Blackjack Win');
  assert.equal(rendered.color, 0x654321);
  assert.equal(rendered.description, 'Payout: **$60**\nCash balance: **$160**');
  assert.equal(rendered.fields[0].value, '<:ace:500000000000000021> <:king:500000000000000022>\nValue: **21**');
});

test('legacy Blackjack styling cannot restore Cards Remaining', () => {
  const result = stripBlackjackCardsRemaining({
    title: 'Result: Win',
    description: 'Payout: **$20**\nCash balance: **$120**\n\nCards remaining: **42**',
    fields: [
      { name: 'Your Hand', value: '20' },
      { name: 'Dealer Hand', value: '18' },
    ],
  });

  assert.equal(isBlackjackEmbed(result), true);
  assert.equal(result.description, 'Payout: **$20**\nCash balance: **$120**');
});

test('embed manager shows one editable casino template for repeated dynamic results', () => {
  const guildId = '100000000000000011';
  const channelId = '200000000000000011';
  const guild = buildGuild({ guildId, channelId, messages: new Map() });
  guild.channels.cache.get(channelId).name = 'gambling';

  const catalogRecord = (messageId, title, createdAt) => ({
    guildId,
    channelId,
    backingChannelId: '900000000000000011',
    messageId,
    embedIndex: 0,
    source: 'system-catalog',
    title,
    name: title,
    createdAt,
  });

  const payload = buildEmbedPayload(guild, [
    catalogRecord('300000000000000021', 'Blackjack — Bet $10', '2026-09-01T20:00:00.000Z'),
    catalogRecord('300000000000000022', 'Blackjack — Bet $100', '2026-09-01T20:01:00.000Z'),
    catalogRecord('300000000000000023', 'Result: Loss', '2026-09-01T20:02:00.000Z'),
    catalogRecord('300000000000000024', 'Result: Loss', '2026-09-01T20:03:00.000Z'),
  ], channelId);

  const options = payload.components[0].toJSON().components[0].options;
  assert.equal(options.length, 2);
  assert.ok(options.some(option => option.label === 'Blackjack bet'));
  assert.ok(options.some(option => option.label === 'Blackjack loss'));
  assert.ok(options.some(option => /applies to 2 matching embed\(s\)/.test(option.description)));
});

test('audit log lookup returns immediately when Discord already has the entry', async () => {
  const expected = {
    target: { id: 'target-user' },
    createdTimestamp: Date.now(),
  };
  let fetchCount = 0;
  const guild = {
    fetchAuditLogs: async () => {
      fetchCount += 1;
      return { entries: { find: predicate => predicate(expected) ? expected : null } };
    },
  };

  const result = await fetchRecentAuditEntry(guild, 20, 'target-user');
  assert.equal(result, expected);
  assert.equal(fetchCount, 1);
});

test('new persistent feature embeds appear in both normal selection and Search, including public replies', async () => {
  installTestStorage();
  const guildId = 'new-feature-guild', channelId = 'new-feature-channel';
  const guild = { id: guildId, channels: { cache: new Map([[channelId, { id: channelId, name: 'youtube' }]]) } };
  for (const [index, title] of ['🎥 Content Creators', 'Ticket reopened', 'Report case notification', 'New persistent feature'].entries()) {
    const message = { id: 'feature-' + index, guildId, channelId, guild, client: { user: { id: 'bot' } }, author: { id: 'bot' }, channel: { name: 'youtube' }, embeds: [{ title, description: 'Real feature content' }], flags: { has: () => false }, interactionMetadata: { id: 'public-reply' } };
    assert.equal(await registerCloudyEmbedMessage(message, 'automatic'), true);
  }
  const records = await getEmbedRegistry(guildId);
  for (const title of ['🎥 Content Creators', 'Ticket reopened', 'Report case notification', 'New persistent feature']) {
    assert.ok(records.some(r => r.title === title), title);
    assert.ok(buildLiveSearchMatches(guild, records, title).length > 0, title);
  }
  assert.equal(templateIdentity(channelId, { title: 'Ticket reopened' }), 'ticket-log:reopen');
});



test('purgeEmbedRegistryRecord permanently removes a stale manual Builder record', async () => {
  installTestStorage();
  const guildId = 'safe-delete-guild';
  const channelId = 'safe-delete-channel';
  const messageId = 'safe-delete-message';

  await setInDb(`cloudy:embed-registry:${guildId}`, [{
    guildId,
    channelId,
    messageId,
    embedIndex: 0,
    source: 'embed-builder',
    title: 'Ghost embed',
    name: 'Ghost embed',
    snapshot: {
      title: 'Ghost embed',
      description: 'No Discord message exists anymore.',
    },
    detached: true,
    createdAt: '2026-10-05T09:00:00.000Z',
  }]);

  assert.equal((await getEmbedRegistry(guildId)).length, 1);
  assert.equal(await purgeEmbedRegistryRecord(guildId, channelId, messageId, 0), true);
  assert.equal((await getEmbedRegistry(guildId)).length, 0);
});
