import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection } from 'discord.js';
import { db } from '../src/utils/database.js';
import { openEmbedManager, buildChannelPayload, prepareEmbedManager } from '../src/services/embedManagerService.js';
import { registerCloudyEmbedMessage } from '../src/services/embedRegistryService.js';
import { registerBuilderSessionCollector, deleteBuilderSessionMessage } from '../src/utils/builderSessionCleanup.js';

test('Modify renders its unchanged controls in one reply and pagination in one update', async () => {
  db.initialized = true; db.useFallback = false; db.connectionType = 'test';
  const record = { guildId: 'latency-manager', channelId: 'channel-a', messageId: 'message-a',
    embedIndex: 0, source: 'embed-builder', title: 'Owner guide', name: 'Owner guide',
    snapshot: { title: 'Owner guide', description: 'Keep this unchanged.' },
    createdAt: '2026-10-07T00:00:00Z' };
  db.db = { get: async () => [record], set: async () => true };
  const collector = new EventEmitter();
  collector.stop = () => { collector.ended = true; };
  const channel = { id: 'channel-a', name: 'guide', type: 0, parentId: null, isTextBased: () => true };
  const guild = { id: 'latency-manager', channels: { cache: new Collection([[channel.id, channel]]) },
    client: { user: { id: 'cloudy' } } };
  let replies = 0, defers = 0, follows = 0;
  let paint;
  const state = {};
  await openEmbedManager({
    guild, client: guild.client, user: { id: 'owner' },
    reply: async payload => { replies += 1; paint = payload; return { resource: { message: {
      id: 'manager', createMessageComponentCollector: () => collector,
    } } }; },
    deferUpdate: async () => { defers += 1; },
    followUp: async payload => { follows += 1; paint = payload; return {
      id: 'manager', createMessageComponentCollector: () => collector,
    }; },
    webhook: { editMessage: async () => {}, deleteMessage: async () => {} },
  }, state, async () => true);
  assert.equal(replies, 1);
  assert.equal(defers, 0);
  assert.equal(follows, 0);
  const serialize = payload => JSON.parse(JSON.stringify(payload));
  const expected = serialize(buildChannelPayload(guild, [record], 0, new Set()));
  assert.deepEqual(serialize(paint.components), expected.components);
  assert.deepEqual(serialize(paint.embeds), expected.embeds);
  let updates = 0;
  const component = {
    customId: 'simple_embed_modify_channel_page:0', user: { id: 'owner' },
    update: async payload => { updates += 1; assert.deepEqual(serialize(payload.components), expected.components); },
    deferUpdate: async () => { defers += 1; },
    editReply: async () => assert.fail('pagination must use the component acknowledgement'),
  };
  collector.emit('collect', component);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  assert.equal(updates, 1);
  assert.equal(defers, 0);
  collector.stop();
});

test('direct Modify replies retain parent activity and private webhook cleanup even before background refresh', async () => {
  db.initialized = true; db.useFallback = false; db.connectionType = 'test';
  let reads = 0;
  db.db = { get: async () => { reads += 1; if (reads === 1) return []; return new Promise(() => {}); } };
  const guild = { id: 'lifetime-manager', channels: { cache: new Collection() }, client: { user: { id: 'cloudy' } } };
  const parent = { id: 'lifetime-parent', embeds: [{ title: 'Message builder' }], delete: async () => {} };
  let parentResets = 0, webhookDeletes = 0;
  registerBuilderSessionCollector(parent, { resetTimer: () => { parentResets += 1; }, stop: () => {} });
  const collector = new EventEmitter(); collector.stop = () => { collector.ended = true; };
  collector.resetTimer = () => {};
  let manager;
  await openEmbedManager({ guild, client: guild.client, user: { id: 'owner' }, message: parent,
    reply: async payload => { manager = { id: 'lifetime-child', embeds: payload.embeds.map(embed => embed.toJSON()),
      delete: async () => assert.fail('private messages must be deleted through their webhook'),
      createMessageComponentCollector: () => collector }; return { resource: { message: manager } }; },
    webhook: { deleteMessage: async id => { assert.equal(id, 'lifetime-child'); webhookDeletes += 1; } },
  }, {}, async () => true);
  const beforeClick = parentResets;
  collector.emit('collect', { customId: 'simple_embed_modify_channel_page:0', user: { id: 'owner' }, update: async () => {} });
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  assert.ok(parentResets > beforeClick, 'pagination must extend the parent Builder lifetime');
  assert.equal(await deleteBuilderSessionMessage(manager), true);
  assert.equal(webhookDeletes, 1);
  await deleteBuilderSessionMessage(parent);
});

test('registry mutations invalidate the preloaded Modify snapshot without any history fetch', async () => {
  const values = new Map();
  db.initialized = true; db.useFallback = false; db.connectionType = 'test';
  let reads = 0;
  db.db = { get: async key => { reads += 1; return structuredClone(values.get(key) || null); },
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; } };
  const channel = { id: 'fresh-channel', name: 'fresh', type: 0, isTextBased: () => true,
    messages: { fetch: () => assert.fail('preloading must not scan Discord history') } };
  const guild = { id: 'fresh-manager', channels: { cache: new Collection([[channel.id, channel]]) }, client: { user: { id: 'cloudy' } } };
  const state = {};
  prepareEmbedManager(guild, state);
  const prepared = state.embedManagerPrepared;
  prepareEmbedManager(guild, state);
  assert.equal(state.embedManagerPrepared, prepared);
  await prepared;
  await registerCloudyEmbedMessage({ id: 'new-guide', guildId: guild.id, channelId: channel.id, channel,
    author: guild.client.user, client: guild.client, createdAt: new Date(), flags: { has: () => false },
    embeds: [{ title: 'New owner guide', description: 'Durable manual text' }], components: [] }, 'embed-builder');
  const readsBeforeOpen = reads;
  const collector = new EventEmitter(); collector.stop = () => { collector.ended = true; };
  let paint;
  await openEmbedManager({ guild, client: guild.client, user: { id: 'owner' },
    reply: async payload => { paint = payload; return { resource: { message: { id: 'fresh-message', createMessageComponentCollector: () => collector } } }; },
    webhook: { editMessage: async () => {} },
  }, state, async () => true);
  assert.ok(reads > readsBeforeOpen, 'a mutation requires a fresh storage read');
  assert.match(paint.embeds[0].toJSON().description, /\*\*Embeds found:\*\* 1/);
  assert.equal(state.embedManagerPrepared, undefined);
  collector.stop();
});

test('a slow registry silently acknowledges before the Discord deadline and retains the same private follow-up', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  db.initialized = true; db.useFallback = false; db.connectionType = 'test';
  let release;
  db.db = { get: () => new Promise(resolve => { release = resolve; }), set: async () => true };
  const collector = new EventEmitter();
  collector.stop = () => { collector.ended = true; };
  const guild = { id: 'slow-latency-manager', channels: { cache: new Collection() }, client: { user: { id: 'cloudy' } } };
  let defers = 0, follows = 0;
  const interaction = {
    guild, client: guild.client, user: { id: 'owner' },
    reply: async () => assert.fail('a silently deferred component needs a follow-up'),
    deferUpdate: async () => { defers += 1; interaction.deferred = true; },
    followUp: async payload => { follows += 1; assert.equal(payload.flags, 64); return { id: 'slow-manager', createMessageComponentCollector: () => collector }; },
    webhook: { editMessage: async () => {}, deleteMessage: async () => {} },
  };
  const opening = openEmbedManager(interaction, {}, async () => true);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  t.mock.timers.tick(800);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  assert.equal(defers, 1, 'acknowledge before three seconds even if storage hangs');
  release([]);
  await opening;
  assert.equal(follows, 1);
  collector.stop();
});
