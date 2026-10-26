import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed, MessageFlags } from 'discord.js';
import { saveModifiedEmbed, loadRecordSnapshotIntoState } from '../src/services/embedManagerService.js';
import { getCachedSavedEmbedTemplateData } from '../src/services/embedTemplateService.js';
import { recordTitle } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { discoverRecentChannelEmbeds } from '../src/services/embedMissingChannelService.js';
import { db } from '../src/utils/database.js';

function fixture(extra = {}) {
  const stored = new Map();
  db.initialized = true; db.useFallback = false;
  db.db = { get: async key => stored.get(key) || null, set: async (key, value) => { stored.set(key, value); return true; } };
  const edits = [];
  const message = {
    id: 'beg-result', guildId: 'command-save-guild', channelId: 'gambling',
    author: { id: 'bot' }, flags: { has: () => false },
    embeds: [new Embed({ title: 'Insufficient Funds', description: 'You gave up.' })],
    ...extra,
  };
  message.edit = async payload => {
    edits.push(payload);
    message.embeds = payload.embeds.map(data => new Embed(data));
    return message;
  };
  const channel = {
    id: message.channelId, guild: { id: message.guildId },
    messages: { cache: new Collection([[message.id, message]]), fetch: async () => message },
  };
  message.channel = channel;
  const guild = {
    id: message.guildId, client: { user: { id: 'bot' } },
    channels: { cache: new Map([[channel.id, channel]]) },
  };
  const state = {
    title: 'Insufficient funds', message: 'Edited beg response', embedFields: [],
    sideColor: 0xFFFFFF, showLogo: false,
    modifyTarget: {
      channelId: channel.id, messageId: message.id, embedIndex: 0,
      sourceEmbedData: message.embeds[0].toJSON(), templateMode: false,
    },
  };
  return { message, channel, guild, state, edits };
}

test('Save edits public slash command results with modern and legacy metadata, including repeated saves', async () => {
  for (const metadata of [{ interactionMetadata: { id: 'command' } }, { interaction: { id: 'command' } }]) {
    const { guild, state, edits } = fixture(metadata);
    assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
    state.message = 'Second edit';
    assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
    assert.equal(edits.length, 2);
    assert.equal(edits[1].embeds[0].description, 'Second edit');
  }
});

test('Save still refuses private results and the real-looking preview within a Builder panel', async () => {
  for (const extra of [
    { flags: { has: flag => flag === MessageFlags.Ephemeral } },
    { embeds: [new Embed({ title: 'Insufficient funds' }), new Embed({ title: 'Message builder' })] },
    { embeds: [new Embed({ title: 'Modify embed' })] },
    { author: { id: 'other-bot' } },
  ]) {
    const { guild, state, edits } = fixture(extra);
    assert.equal((await saveModifiedEmbed(guild, state)).ok, false);
    assert.equal(edits.length, 0);
  }
});

test('discovery excludes public command instances and whole Builder preview panels', async () => {
  const { message, channel, guild } = fixture({ interactionMetadata: { id: 'command' } });
  const panel = {
    ...message, id: 'builder-panel',
    embeds: [new Embed({ title: 'Insufficient funds' }), new Embed({ title: 'Message builder' })],
  };
  const messages = new Collection([[panel.id, panel], [message.id, message]]);
  channel.messages.cache = messages;
  channel.messages.fetch = async () => messages;
  const records = await discoverRecentChannelEmbeds(guild, channel.id, 'bot');
  assert.deepEqual(records.map(record => record.messageId), [],
    'a command invocation is not a reusable channel embed until explicitly posted or saved');
});


test('Search Save persists an owner-edited system template when its catalog message no longer exists', async () => {
  const guildId = 'search-save-virtual-catalog-20261026';
  const channelId = 'botlog-missing-original';
  const key = 'source:missing-catalog-test';
  const original = {
    title: 'Removed from Builder',
    description: 'Original response.',
    color: 0xFFFFFF,
    author: { name: 'Cloudy template key: source:missing-catalog-test || Cloudy context: embed-builder/delete || Cloudy kind: embed' },
  };
  const record = { guildId, channelId, backingChannelId: channelId,
    messageId: 'deleted-catalog-master', embedIndex: 0, source: 'system-catalog',
    title: original.title, snapshot: original };
  const storage = new Map();
  db.initialized = true; db.useFallback = false;
  db.db = {
    get: async (k, fallback) => structuredClone(storage.get(k) ?? fallback),
    set: async (k, value) => { storage.set(k, structuredClone(value)); return true; },
  };
  let physicalEdits = 0;
  const channel = { id: channelId, messages: {
    fetch: async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); },
  } };
  const guild = { id: guildId, client: { user: { id: 'cloudy-bot' } },
    channels: { cache: new Map([[channelId, channel]]) } };
  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, guild, record), true);
  state.title = 'Removed from builder ✅';
  state.message = 'Updated by owner';
  const saved = await saveModifiedEmbed(guild, state);
  assert.equal(saved.ok, true, 'a missing catalog post should still Save its reusable response');
  assert.equal(physicalEdits, 0, 'do not recreate, post or edit a deleted catalog message');
  assert.equal(getCachedSavedEmbedTemplateData(guildId, channelId, original).data.title, state.title);
  assert.equal(recordTitle(record), state.title, 'Search reads the same saved title immediately');
});
