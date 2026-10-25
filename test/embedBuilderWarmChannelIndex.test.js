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


test('cached bot embeds make channel choices immediate and new empty channels show No embeds', () => {
  const guildId = 'cached-channel-lookup-oct25', botUserId = 'bot-user-oct25';
  let apiReads = 0;
  const message = {
    id: '111111111111111223', guildId, channelId: '111111111111111224',
    author: { id: botUserId }, createdAt: new Date('2026-10-25T16:00:00Z'),
    embeds: [{ title: 'Report case created', description: 'Full cached report text.' }],
    components: [], flags: { has: () => false },
  };
  const messages = new Collection([[message.id, message]]);
  const channel = { id: message.channelId, name: 'report-logs', type: 0,
    messages: { cache: messages, async fetch() { apiReads++; return messages; } } };
  const empty = { id: '111111111111111225', name: 'new-channel', type: 0,
    messages: { cache: new Collection(), async fetch() { apiReads++; return new Collection(); } } };
  const guild = { id: guildId, channels: { cache: new Collection([[channel.id, channel], [empty.id, empty]]) } };
  const records = peekCachedPhysicalChannelEmbeds(guild, botUserId);
  assert.equal(records.length, 1);
  assert.equal(records[0].snapshot.description, 'Full cached report text.');
  const payload = buildChannelPayload(guild, records);
  const options = payload.components[0].components[0].options.map(x => x.toJSON());
  assert.equal(options.find(x => x.value === channel.id)?.description, 'Open embeds');
  assert.equal(options.find(x => x.value === empty.id)?.description, 'No embeds');
  assert.ok(!options.some(x => /Checking embeds/.test(x.description)));
  assert.equal(apiReads, 0);
});
