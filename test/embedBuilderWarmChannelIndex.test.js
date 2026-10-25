import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MessageFlags } from 'discord.js';
import {
  discoverRecentChannelEmbeds,
  peekIndexedRecentChannelEmbeds,
  isUsableMessage,
} from '../src/services/embedMissingChannelService.js';
import { buildEmbedPayload } from '../src/services/embedManagerService.js';

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
