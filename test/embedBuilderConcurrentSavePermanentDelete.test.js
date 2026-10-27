import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import { saveModifiedEmbed } from '../src/services/embedManagerService.js';
import {
  getEmbedRegistry, purgeEmbedRegistryRecord, isRecentlyPurgedMessage,
  registerCloudyEmbedMessage,
} from '../src/services/embedRegistryService.js';
import { withEmbedBuilderMessageMutation } from '../src/services/embedBuilderMutationLock.js';

const channelId = '187777700000000000';
const messageId = '187777700000000001';
const imageUrl = 'https://example.com/cloudy-banner.gif';
const original = { title: 'TEST 1', description: 'Original body', color: 0xF1F1F1,
  image: { url: imageUrl }, footer: { text: 'Cloudy footer' } };

function fixture(t, guildId) {
  const store = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(store.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => {
    store.set(key, structuredClone(value));
    return true;
  });
  let edits = 0, reads = 0;
  const message = {
    id: messageId, guildId, channelId,
    author: { id: 'bot' }, content: '', components: [], createdAt: new Date(),
    flags: { has: () => false }, embeds: [new Embed(original)],
    attachments: new Collection(),
  };
  const channel = {
    id: channelId, name: 'general',
    messages: { fetch: async (id, options) => {
      reads++;
      assert.equal(id, messageId);
      assert.equal(options?.force, true);
      return message;
    } },
  };
  message.channel = channel;
  message.edit = async payload => {
    edits++;
    message.embeds = payload.embeds.map(data => new Embed(data));
    return message;
  };
  const guild = { id: guildId, client: { user: { id: 'bot' } },
    channels: { cache: new Map([[channelId, channel]]) } };
  const state = () => ({
    title: original.title, message: original.description, sideColor: original.color,
    bottomLine: original.footer.text, embedFields: [], showLogo: false, mediaUrl: imageUrl,
    modifyTarget: {
      guildId, channelId, messageId, source: 'embed-builder',
      manualSaved: true, embedIndex: 0, templateMode: false,
      sourceEmbedData: structuredClone(original),
      previewSourceData: structuredClone(original), cachedMessage: message,
    },
  });
  return { guild, message, store, state,
    get editCount() { return edits; }, get readCount() { return reads; } };
}

test('stale Builder editor saves its changed color without reverting the latest title or GIF', async t => {
  const x = fixture(t, 'race-color-20261027');
  const first = x.state(), stale = x.state();
  first.title = 'TEST 2';
  first.message = 'New body';
  stale.sideColor = 0x2277AA;
  assert.equal((await saveModifiedEmbed(x.guild, first)).ok, true);
  assert.equal((await saveModifiedEmbed(x.guild, stale)).ok, true);
  assert.equal(x.message.embeds[0].title, 'TEST 2');
  assert.equal(x.message.embeds[0].description, 'New body');
  assert.equal(x.message.embeds[0].color, 0x2277AA);
  assert.equal(x.message.embeds[0].image.url, imageUrl);
  assert.equal(stale.title, 'TEST 2');
  assert.equal(stale.message, 'New body');
  assert.equal(x.editCount, 2);
  assert.ok(x.readCount >= 2);
  const saved = await getEmbedRegistry(x.guild.id);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].snapshot.title, 'TEST 2');
});

test('an unchanged older session never PATCHes the old version over a new title', async t => {
  const x = fixture(t, 'race-noop-20261027');
  const stale = x.state(), fresh = x.state();
  fresh.title = 'Latest';
  assert.equal((await saveModifiedEmbed(x.guild, fresh)).ok, true);
  assert.equal((await saveModifiedEmbed(x.guild, stale)).ok, true);
  assert.equal(x.message.embeds[0].title, 'Latest');
  assert.equal(x.editCount, 1);
  assert.equal(stale.title, 'Latest');
});

test('confirmed Delete persists a tombstone that prevents reimport after restart', async t => {
  const x = fixture(t, 'durable-deletion-20261027');
  assert.equal(await registerCloudyEmbedMessage(x.message, 'embed-builder', {
    manualSave: true, manualSaveIndex: 0,
  }), true);
  assert.equal(await purgeEmbedRegistryRecord(x.guild.id, channelId, messageId, null), true);
  assert.equal(isRecentlyPurgedMessage({ guildId: x.guild.id, channelId, messageId }), true);
  assert.equal((await getEmbedRegistry(x.guild.id)).length, 0);
  assert.ok(x.store.get('cloudy:embed-registry-deleted:' + x.guild.id)
    .includes(channelId + ':' + messageId));
  const restarted = await import('../src/services/embedRegistryService.js?durable-test-restart-20261027');
  assert.deepEqual(await restarted.getEmbedRegistry(x.guild.id), []);
  assert.equal(restarted.isRecentlyPurgedMessage({ guildId: x.guild.id, channelId, messageId }), true);
  assert.equal(await restarted.registerCloudyEmbedMessage(x.message, 'embed-builder', {
    manualSave: true, manualSaveIndex: 0,
  }), true);
  assert.equal((await restarted.getEmbedRegistry(x.guild.id)).length, 0);
});

test('Save and Delete on one physical message run strictly in order', async () => {
  const seen = [];
  let started, release;
  const onStart = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const first = withEmbedBuilderMessageMutation('test-order', channelId, messageId, async () => {
    seen.push('save start'); started(); await gate; seen.push('save end');
  });
  await onStart;
  const second = withEmbedBuilderMessageMutation('test-order', channelId, messageId, async () => {
    seen.push('delete start'); seen.push('delete end');
  });
  release();
  await Promise.all([first, second]);
  assert.deepEqual(seen, ['save start', 'save end', 'delete start', 'delete end']);
});
