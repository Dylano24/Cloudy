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
