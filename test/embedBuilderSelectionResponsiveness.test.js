import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';

function requireEarlyAckSource() {
  return fs.readFileSync('src/events/interactionCreate.js', 'utf8');
}
import { EventEmitter } from 'node:events';
import embedBuilderCommand from '../src/commands/Tools/embedbuilder.js';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry } from '../src/services/embedRegistryService.js';
import { warmSavedEmbedTemplateScopes } from '../src/services/embedTemplateService.js';
import * as search from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { applyInitialSearchSelectionToState } from '../src/services/embedManagerService.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from '../src/services/cloudyBrandingService.js';

test('a warm Search selection opens its complete snapshot without waiting for registry storage', async t => {
  assert.equal(typeof search.loadEmbedBuilderSearchSelection, 'function');
  const record = {
    guildId: 'instant-selection', channelId: '111111111111111111', messageId: '222222222222222222',
    embedIndex: 0, source: 'embed-builder', snapshot: {
      title: 'Rules PANEL', description: 'Exact saved body', color: 0x123456,
      fields: [{ name: 'Field', value: 'Full value', inline: true }],
      footer: { text: 'Saved footer' }, thumbnail: { url: 'https://example.com/logo.png' },
      image: { url: 'https://example.com/image.png' },
    }, components: [{ type: 1, components: [{ type: 2, style: 2, label: 'Old button', custom_id: 'same_action' }] }],
  };
  const liveComponents = [{ type: 1, components: [{ type: 2, style: 2, label: 'Saved button', custom_id: 'same_action' }] }];
  t.mock.method(db, 'get', async key => key.startsWith('cloudy:embed-registry:') ? [record] : {});
  await getEmbedRegistry(record.guildId);
  await warmSavedEmbedTemplateScopes(record.guildId, [record.channelId]);
  let privateRead = false;
  t.mock.method(db, 'get', async () => { privateRead = true; return new Promise(() => {}); });
  const channel = {
    id: record.channelId, guildId: record.guildId, permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => ({ embeds: [{ toJSON: () => record.snapshot }], components: liveComponents }) },
  };
  const interaction = {
    guildId: record.guildId, member: { id: 'owner' }, user: { id: 'owner' },
    guild: { id: record.guildId, channels: { cache: new Map([[channel.id, channel]]) } },
    options: { getString: () => `${record.channelId}:${record.messageId}:0` },
  };
  const started = performance.now();
  const selection = await Promise.race([
    search.loadEmbedBuilderSearchSelection(interaction),
    new Promise(resolve => { setTimeout(() => resolve(null), 500); }),
  ]);
  assert.ok(selection, 'selection must not wait for the stalled storage refresh');
  assert.ok(performance.now() - started < 500);
  assert.equal(privateRead, false, 'warm Search selections do not start a new registry read');
  const state = {};
  assert.equal(applyInitialSearchSelectionToState({ ...interaction, __cloudyInitialBuilderSelection: selection }, state), true);
  assert.equal(state.title, 'Rules PANEL');
  assert.equal(state.message, 'Exact saved body');
  assert.deepEqual(state.embedFields, record.snapshot.fields);
  assert.equal(state.mediaUrl, record.snapshot.image.url);
  assert.equal(state.bottomLine, 'Saved footer');
  assert.deepEqual(state.componentRows, liveComponents, 'a stale registry copy must not replace newer live buttons');
});

test('slow selection preparation acknowledges Discord before the interaction expires', async () => {
  assert.equal(typeof search.withBuilderSelectionAcknowledgement, 'function');
  const events = [];
  const interaction = { deferred: false, replied: false,
    async deferReply() { events.push('ack'); this.deferred = true; } };
  const result = await search.withBuilderSelectionAcknowledgement(interaction, async () => {
    await new Promise(resolve => { setTimeout(resolve, 30); });
    events.push('ready');
    return 'complete selection';
  }, 5);
  assert.equal(result, 'complete selection');
  assert.deepEqual(events, ['ack', 'ready']);
});

test('fast selection preparation needs no extra Discord acknowledgement round trip', async () => {
  assert.equal(typeof search.withBuilderSelectionAcknowledgement, 'function');
  const interaction = { deferReply: async () => assert.fail('fast rendering must reply directly') };
  assert.equal(await search.withBuilderSelectionAcknowledgement(interaction, async () => 'ready', 5), 'ready');
  await new Promise(resolve => { setTimeout(resolve, 10); });
});

test('selected Builder Search is acknowledged before expensive configuration or catalog preparation', () => {
  const source = requireEarlyAckSource();
  const begin = source.indexOf('ResponseCoordinator.attach(interaction)');
  const earlyAck = source.indexOf("interaction.commandName === 'embedbuilder'", begin);
  const defer = source.indexOf('await interaction.deferReply()', earlyAck);
  const validations = source.indexOf('validateChatInputPayloadOrThrow(interaction', begin);
  const guildConfig = source.indexOf('const guildConfigPromise = interaction.guild', begin);
  const handler = source.indexOf('await command.execute(interaction', begin);
  assert.ok(begin >= 0 && earlyAck > begin);
  assert.ok(defer > earlyAck && defer < validations && defer < guildConfig && defer < handler,
    'Discord must receive the Search acknowledgement before potentially blocking work');
  assert.match(source.slice(earlyAck, defer), /getString\?\.\('search'\)/);
});

test('a pre-deferred Search selection does not attempt to acknowledge Discord twice', async () => {
  const events = [];
  const interaction = {
    deferred: true,
    replied: false,
    async deferReply() { assert.fail('already deferred by interaction router'); },
  };
  const result = await search.withBuilderSelectionAcknowledgement(interaction, async () => {
    events.push('loaded');
    return 'ready';
  }, 1);
  assert.equal(result, 'ready');
  assert.deepEqual(events, ['loaded']);
});

test('automatic botlog template previews use the Search casing without rewriting their source', () => {
  const record = { guildId: 'preview-case', channelId: 'catalog', messageId: 'template', source: 'system-catalog',
    snapshot: { title: 'Role Removed', description: 'Original body', color: 0xFFFFFF,
      author: { name: 'Cloudy template key: source:role || Cloudy context: botlog/role' } } };
  const original = structuredClone(record);
  const state = {};
  assert.equal(applyInitialSearchSelectionToState({ guild: { id: record.guildId },
    __cloudyInitialBuilderSelection: { record, previewTitle: 'Role removed' } }, state), true);
  assert.equal(state.title, 'Role removed');
  assert.equal(state.modifyTarget.sourceEmbedData.title, 'Role Removed');
  assert.deepEqual(record, original);
});

test('preview casing never changes manual/channel embeds, guides or anything except letter case', () => {
  for (const [source, context, title, previewTitle] of [
    ['embed-builder', 'botlog/role', 'Role Removed', 'Role removed'],
    ['cloudy', 'botlog/role', 'Role Removed', 'Role removed'],
    ['system-catalog', 'faq/panel', 'Cloudy FAQ Panel', 'Cloudy FAQ panel'],
    ['system-catalog', 'botlog/report', 'New report #17', 'New report'],
  ]) {
    const record = { guildId: 'protected-case', channelId: 'channel', messageId: 'source', source,
      snapshot: { title, description: 'Untouched', author: { name: `Cloudy template key: source:test || Cloudy context: ${context}` } } };
    const state = {};
    applyInitialSearchSelectionToState({ guild: { id: record.guildId },
      __cloudyInitialBuilderSelection: { record, previewTitle } }, state);
    assert.equal(state.title, title);
  }
});

test('an acknowledged guild Builder keeps its public preview, dashboard and owner-only controls', async t => {
  t.mock.method(db, 'get', async () => []);
  const collector = new EventEmitter();
  collector.stop = () => { collector.ended = true; collector.emit('end'); };
  t.after(() => collector.stop());
  let previewPayload;
  let dashboardPayload;
  let collectorOptions;
  const preview = { id: 'preview-response', delete: async () => {}, edit: async () => {} };
  const dashboard = { id: 'dashboard-response', delete: async () => {},
    createMessageComponentCollector(options) { collectorOptions = options; return collector; } };
  const interaction = {
    id: 'deferred-builder', token: 'test-builder-token', deferred: true, replied: false,
    guildId: 'deferred-builder-guild', guild: { id: 'deferred-builder-guild' },
    user: { id: 'owner' }, options: { getString: () => '' },
    channel: { async send(payload) { dashboardPayload = payload; return dashboard; } },
    async editReply(payload) { previewPayload = payload; this.replied = true; return preview; },
    reply: async () => assert.fail('an acknowledged command must edit its original response'),
    followUp: async () => assert.fail('guild dashboard must stay bot-managed in the channel'),
    deleteReply: async () => assert.fail('a successful Builder must stay open'),
  };
  await embedBuilderCommand.execute(interaction);
  assert.ok(previewPayload?.embeds?.length);
  assert.equal(previewPayload.flags, undefined);
  assert.equal(dashboardPayload.embeds[0].toJSON().title, 'Message builder');
  assert.equal(dashboardPayload.flags, undefined);
  assert.ok(dashboardPayload.components.length);
  assert.equal(collectorOptions.filter({ isButton: () => true, user: { id: 'owner' }, customId: 'simple_embed_post' }), true);
  assert.equal(collectorOptions.filter({ isButton: () => true, user: { id: 'other' }, customId: 'simple_embed_post' }), false);
});


test('clicking an offered catalog result uses its complete preview while unrelated storage is stalled', async t => {
  const guildId = 'offered-search-fast-preview';
  const channelId = '111111111111111177';
  const messageId = '222222222222222277';
  const record = {
    guildId, channelId, messageId, embedIndex: 0,
    source: 'system-catalog', manualSaved: false,
    title: 'Rare fast preview example', name: 'Rare fast preview example',
    snapshot: {
      title: 'Rare fast preview example',
      description: 'This complete catalog body must be visible on the first paint.',
      color: 0xFFFFFF,
      author: { name: 'Cloudy template key: source:rare-preview || Cloudy context: general/rare-preview || Cloudy kind: embed' },
    },
    createdAt: '2026-10-25T00:00:00Z',
  };
  let stallStorage = false;
  t.mock.method(db, 'get', async (key, fallback) => {
    if (stallStorage) return new Promise(() => {});
    return String(key).startsWith('cloudy:embed-registry:') ? [record] : fallback;
  });
  await getEmbedRegistry(guildId);
  await warmSavedEmbedTemplateScopes(guildId, [channelId]);

  const channel = {
    id: channelId, guildId, name: 'rare-previews',
    permissionsFor: () => ({ has: () => true }),
  };
  const guild = { id: guildId, client: { user: { id: 'cloudy' } },
    channels: { cache: new Map([[channelId, channel]]) } };
  let choices = [];
  const interaction = {
    guildId, guild, client: guild.client,
    user: { id: 'owner' }, member: { id: 'owner' },
    options: {
      getFocused: () => ({ name: 'search', value: 'Rare fast preview example' }),
      getString: () => `${channelId}:${messageId}:0`,
    },
    respond: async offered => { choices = offered; },
  };
  await embedBuilderCommand.autocomplete(interaction);
  assert.ok(choices.some(choice => choice.value === `${channelId}:${messageId}:0`),
    'autocomplete must actually offer the record before it can be reused');
  stallStorage = true;

  const selected = await Promise.race([
    search.loadEmbedBuilderSearchSelection(interaction),
    new Promise(resolve => setTimeout(() => resolve(null), 500)),
  ]);
  assert.ok(selected, 'opening an offered complete preview must not wait on stalled storage');
  assert.equal(selected.record.messageId, messageId);
  assert.equal(selected.previewRecord.snapshot.description, record.snapshot.description);
  const state = {};
  assert.equal(applyInitialSearchSelectionToState({
    ...interaction, __cloudyInitialBuilderSelection: selected,
  }, state), true);
  assert.equal(state.message, record.snapshot.description);
});

test('Modify channel overview starts discovery after sending its first response', () => {
  const source = fs.readFileSync('src/services/embedManagerService.js', 'utf8');
  const start = source.indexOf('export async function openEmbedManager');
  const collector = source.indexOf("collector.on('collect'", start);
  assert.ok(start >= 0 && collector > start);
  const startup = source.slice(start, collector);
  assert.match(startup, /void discoverEmbedManagerOverviewRecords\(/);
  assert.ok(startup.indexOf('markOpen(\'first_visible\')') <
    startup.indexOf('void discoverEmbedManagerOverviewRecords('),
    'channel history scanning must never postpone the first manager response');
});


test('immediate catalog previews retain dynamic values, live peers, and real source titles', () => {
  const base = {
    guildId: 'static-vs-dynamic', channelId: '111111111111111177',
    messageId: '222222222222222277', embedIndex: 0, source: 'system-catalog',
    name: 'Static notice', title: 'Static notice',
    snapshot: {
      title: 'Static notice', description: 'Full static response.',
      author: { name: 'Cloudy template key: source:static-notice || Cloudy context: general/notice' },
    },
  };
  assert.equal(search.canUseImmediateCatalogPreview(base), true);
  assert.equal(search.canUseImmediateCatalogPreview({
    ...base, previewRecord: { source: 'bot-history', snapshot: { title: 'Static notice', description: 'Actual posted text' } },
  }), false, 'a real posted preview wins over an abstract source snapshot');
  assert.equal(search.canUseImmediateCatalogPreview({
    ...base, snapshot: { ...base.snapshot, description: 'You won {dynamic} cash' },
  }), false, 'a dynamic response must retain its runtime preview');
  assert.equal(search.canUseImmediateCatalogPreview({
    ...base, snapshot: { ...base.snapshot, title: 'Updated notice' },
  }), false, 'a Search label must not silently open a differently titled preview');
  assert.equal(search.canUseImmediateCatalogPreview({
    ...base, snapshot: { ...base.snapshot, author: { name: 'Cloudy template key: game:roulette:won || Cloudy context: gambling/roulette' } },
  }), false, 'gambling examples are runtime-owned even when their sample body is static');
});


test('an unsaved Welcome Ping status opens with the clean Search title and no stray emoji', () => {
  const record = {
    guildId: 'welcome-title-guild', channelId: 'welcome',
    messageId: 'catalog-message', embedIndex: 0, source: 'system-catalog',
    manualSaved: false,
    name: '✅ Welcome Ping Updated',
    snapshot: {
      title: '✅ Welcome Ping Updated', description: 'Original welcome ping instructions',
      author: { name: 'Cloudy template key: source:welcome-ping || Cloudy context: welcome/ping' },
    },
  };
  const state = {};
  const original = structuredClone(record);
  assert.equal(applyInitialSearchSelectionToState({
    guild: { id: record.guildId },
    __cloudyInitialBuilderSelection: { record, previewTitle: 'Welcome ping updated' },
  }, state), true);
  assert.equal(state.title, 'Welcome ping updated');
  assert.equal(state.message, record.snapshot.description);
  assert.equal(state.modifyTarget.sourceEmbedData.title, original.snapshot.title);
  assert.deepEqual(record, original, 'preview formatting must not mutate the canonical source');
});

test('an unsaved Welcome Ping live example opens with Search title without rewriting the physical message', () => {
  const record = {
    guildId: 'welcome-live-title-guild', channelId: 'welcome',
    messageId: 'catalog-message', embedIndex: 0, source: 'system-catalog',
    manualSaved: false,
    snapshot: {
      title: '✅ Welcome Ping Updated', description: 'Source description',
      author: { name: 'Cloudy template key: source:welcome-ping || Cloudy context: welcome/ping' },
    },
  };
  const previewRecord = {
    guildId: record.guildId, channelId: 'welcome', messageId: 'live-message',
    embedIndex: 0, source: 'cloudy', snapshot: {
      title: '✅ Welcome Ping Updated', description: 'Live Discord description',
    },
  };
  const state = {};
  assert.equal(applyInitialSearchSelectionToState({
    guild: { id: record.guildId },
    __cloudyInitialBuilderSelection: { record, previewRecord, previewTitle: 'Welcome ping updated' },
  }, state), true);
  assert.equal(state.title, 'Welcome ping updated');
  assert.equal(state.message, previewRecord.snapshot.description);
  assert.equal(previewRecord.snapshot.title, '✅ Welcome Ping Updated', 'live Discord payload must stay untouched');
  assert.equal(state.modifyTarget.sourceEmbedData.title, record.snapshot.title, 'saved source identity must not change');
});


test('unsaved Cloudy logs and game replies match Search sentence case without touching their data', () => {
  for (const [source, title, expected] of [
    ['ticket-log', '✅ TICKET CLOSED', 'Ticket closed'],
    ['cloudy', '🎲 ROULETTE WIN', 'Roulette win'],
    ['bot-history', '⚠️ PERMISSION DENIED', 'Permission denied'],
    ['embed-builder', '✅ WELCOME MESSAGE UPDATED', 'Welcome message updated'],
  ]) {
    const record = {
      guildId: `unsaved-${source}`, channelId: 'log-channel', messageId: 'posted-message',
      embedIndex: 0, source, manualSaved: false,
      snapshot: {
        title, description: 'Full original runtime text', color: 0xFF00FF,
        fields: [{ name: 'Winner', value: '<@123456789012345678>', inline: true }],
        footer: { text: 'Original footer' }, image: { url: 'https://example.com/media.png' },
      },
    };
    const state = {};
    assert.equal(applyInitialSearchSelectionToState({
      guild: { id: record.guildId },
      __cloudyInitialBuilderSelection: { record },
    }, state), true);
    assert.equal(state.title, expected);
    assert.equal(state.message, record.snapshot.description);
    assert.deepEqual(state.embedFields, record.snapshot.fields);
    assert.equal(state.sideColor, 0xFF00FF);
    assert.equal(state.modifyTarget.sourceEmbedData.title, title);
    assert.equal(state.modifyTarget.previewSourceData.title, title);
  }
});

test('explicitly saved and manually Builder-posted titles are immune to automatic rename', () => {
  const cases = [
    { source: 'embed-builder', manualSaved: true, title: '✅ SAVED USER TITLE', footer: { text: 'Saved footer' } },
    { source: 'embed-builder', manualSaved: false, title: '✅ MANUALLY POSTED', footer: { text: 'Footer' + MESSAGE_BUILDER_FOOTER_MARKER } },
  ];
  for (const item of cases) {
    const record = {
      guildId: 'protected-' + item.title, channelId: 'channel', messageId: 'id',
      embedIndex: 0, source: item.source, manualSaved: item.manualSaved,
      snapshot: { title: item.title, description: 'Keep exact text', footer: item.footer },
    };
    const state = {};
    assert.equal(applyInitialSearchSelectionToState({
      guild: { id: record.guildId }, __cloudyInitialBuilderSelection: { record },
    }, state), true);
    assert.equal(state.title, item.title);
    assert.equal(state.modifyTarget.sourceEmbedData.title, item.title);
  }
});

test('channel history discovery overlaps the first Discord update and preview fetch overlaps deferral', () => {
  const source = fs.readFileSync('src/services/embedManagerService.js', 'utf8');
  const channelSelect = source.indexOf("interaction.customId.startsWith('simple_embed_modify_channel:')");
  const previewSelect = source.indexOf("const markPreview = createBuilderPerformanceTracker('channel_preview')");
  assert.ok(channelSelect >= 0 && previewSelect > channelSelect);
  const channel = source.slice(channelSelect, previewSelect);
  const firstPaint = channel.indexOf('const initialPainted = await updateEmbedManager(');
  const startedFetch = channel.indexOf('const recentDiscovery = discoverRecentChannelEmbeds(');
  assert.ok(startedFetch >= 0 && firstPaint > startedFetch, 'discovery must begin before first update finishes');
  assert.ok(channel.indexOf('await recentDiscovery') > firstPaint,
    'fetched results are consumed after immediate channel paint');
  const preview = source.slice(previewSelect, source.indexOf("markPreview('preview_ready')", previewSelect));
  assert.ok(preview.indexOf('const acknowledgement = interaction.deferUpdate();') <
    preview.indexOf('const livePending = cachedLive'), 'acknowledgement starts without delay');
  assert.ok(preview.indexOf('const livePending = cachedLive') < preview.indexOf('const liveMessage = await livePending'),
    'the live-message lookup must start before the acknowledgement finishes');
});
