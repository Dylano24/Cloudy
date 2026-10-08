import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { applyAction } from '../src/services/cloudyFeedService.js';

test('channel dropdown edit saves the new channel without modal input or changing feed settings', async () => {
  const original = {
    id: '04db1b8f',
    name: 'Video feed',
    source: 'https://example.org/gallery',
    channelId: '1532882647838228724',
    channelName: 'previous-channel',
    minutes: 5,
    adult: true,
    active: true,
    lastError: 'No matching media found',
    recentUrls: ['https://example.org/video-1.mp4'],
    nextAt: Date.now() + 9000,
  };
  let stored = [structuredClone(original)];
  const newId = '1532882647838228725';
  const channel = {
    id: newId,
    name: 'new-channel',
    type: ChannelType.GuildText,
    nsfw: true,
    permissionsFor: () => ({ has: () => true }),
  };
  const guild = {
    id: '1532882647838228723',
    members: { me: {} },
    channels: { fetch: async id => id === newId ? channel : null },
  };
  const client = {
    db: {
      get: async () => structuredClone(stored),
      set: async (_key, value) => { stored = structuredClone(value); },
      getStatus: () => ({ isDegraded: false }),
    },
  };
  const interaction = { client, isModalSubmit: () => false };
  const result = await applyAction(interaction, guild, 'edit', {
    feedId: original.id, channel: newId,
  });
  assert.equal(result[0].channelId, newId);
  assert.equal(result[0].channelName, 'new-channel');
  assert.equal(result[0].name, original.name);
  assert.equal(result[0].source, original.source);
  assert.equal(result[0].minutes, original.minutes);
  assert.equal(result[0].adult, original.adult);
  assert.equal(result[0].active, original.active);
  assert.deepEqual(result[0].recentUrls, original.recentUrls);
  assert.equal(result[0].lastError, original.lastError);
  assert.equal(stored[0].channelId, newId);
});
