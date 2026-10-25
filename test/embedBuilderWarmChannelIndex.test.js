import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MessageFlags } from 'discord.js';
import {
  discoverRecentChannelEmbeds,
  peekIndexedRecentChannelEmbeds,
  peekCachedPhysicalChannelEmbeds,
  isUsableMessage,
} from '../src/services/embedMissingChannelService.js';
import { buildEmbedPayload, buildChannelPayload } from '../src/services/embedManagerService.js';

test('read-only warm channel lookup offers verified embeds without new Discord requests or Save', async () => {
  const guildId = 'warm-private-20261025';
  const channelId = '1620202020202020202';
  const msgId = '1620202020202020203';
  let reads = 0;
  const msg = {
    id: msgId, guildId, channelId, author: { id: 'cloudy' },
    createdAt: new Date('2026-10-25T09:00:00Z'),
    createdTimestamp: Date.parse('2026-10-25T09:00:00Z'),
    flags: { has: () => false },
    embeds: [{ title: 'Report case created', description: 'Original full report body' }],
    components: [],
  };
  const channel = {
    id: channelId, name: 'report-logs', guildId, type: 0,
    toString: () => '#report-logs',
    messages: {
      cache: new Collection([[msgId, msg]]),
      fetch: async () => {
        reads++;
        const batch = new Collection([[msgId, msg]]);
        return batch;
      },
    },
  };
  const guild = { id: guildId, client: { user: { id: 'cloudy' } },
    channels: { cache: new Collection([[channelId, channel]]) } };
  assert.deepEqual(peekIndexedRecentChannelEmbeds(guild), []);
  const fetched = await discoverRecentChannelEmbeds(guild, channelId, 'cloudy');
  assert.equal(reads, 1);
  assert.equal(fetched.length, 1);
  const cached = peekIndexedRecentChannelEmbeds(guild);
  assert.equal(reads, 1, 'opening warm indexed channels does not issue a second Discord API request');
  assert.equal(cached.length, 1);
  assert.equal(cached[0].snapshot.description, 'Original full report body');
  const payload = buildEmbedPayload(guild, cached, channelId);
  const select = payload.components[0].toJSON().components[0];
  assert.equal(select.options[0].value, msgId + ':0');
  assert.equal(reads, 1);
});

test('private Builder command replies are never indexed as physical channel posts', () => {
  const msg = {
    guildId: 'private-guild', channelId: 'private-channel',
    author: { id: 'cloudy' }, embeds: [{ title: 'Report case created' }],
    flags: { has: flag => flag === MessageFlags.Ephemeral },
  };
  assert.equal(isUsableMessage(msg, 'cloudy'), false);
  assert.equal(isUsableMessage({ ...msg, flags: { has: () => false },
    interactionMetadata: { commandName: 'embedbuilder' } }, 'cloudy'), false);
});


test('a channel with a cached bot embed immediately offers Open embeds; empty channel says No embeds', () => {
  const id = 'cached-immediate-guild';
  const botId = 'cached-immediate-bot';
  const channelId = '111111111111111222';
  let fetchCalls = 0;
  const msg = {
    id: '111111111111111223', guildId: id, channelId, author: { id: botId },
    embeds: [{ title: 'Cloudy announcement', description: 'Existing channel embed.' }],
    createdAt: new Date('2026-10-25T16:00:00Z'),
    flags: { has: () => false }, components: [],
  };
  const first = { id: channelId, name: 'welcome', type: 0, position: 1, rawPosition: 1,
    messages: { cache: new Collection([[msg.id, msg]]), async fetch() { fetchCalls++; return new Collection(); } } };
  const second = { id: '111111111111111224', name: 'new-channel', type: 0, position: 2, rawPosition: 2,
    messages: { cache: new Collection(), async fetch() { fetchCalls++; return new Collection(); } } };
  const guild = { id, channels: { cache: new Collection([[first.id, first],[second.id, second]]) } };
  const found = peekCachedPhysicalChannelEmbeds(guild, botId);
  assert.equal(found.length, 1);
  assert.equal(found[0].snapshot.description, 'Existing channel embed.');
  const menu = buildChannelPayload(guild, found);
  const options = menu.components[0].components[0].options.map(option => option.toJSON());
  assert.equal(options.find(option => option.value === first.id).description, 'Open embeds');
  assert.equal(options.find(option => option.value === second.id).description, 'No embeds');
  assert.ok(options.every(option => !option.description.includes('Checking')));
  assert.equal(fetchCalls, 0, 'first response must not wait for a Discord API history fetch');
});

test('a real bot embed remains private when it was an ephemeral or slash-command response', () => {
  const guildId = 'cached-private-guild';
  const channelId = '111111111111111225';
  const fake = (id, flags, metadata) => ({
    id, guildId, channelId, author: { id: 'bot' }, embeds: [{ title: 'Should not appear' }],
    createdAt: new Date(), flags: { has: f => f === MessageFlags.Ephemeral && flags },
    interactionMetadata: metadata,
  });
  const channel = { id: channelId, type: 0, messages: { cache: new Collection([
    ['ephemeral', fake('ephemeral', true, null)],
    ['slash', fake('slash', false, { commandName: 'embedbuilder' })],
  ]) } };
  const guild = { id: guildId, channels: { cache: new Collection([[channelId,channel]]) } };
  assert.deepEqual(peekCachedPhysicalChannelEmbeds(guild, 'bot'), []);
});
