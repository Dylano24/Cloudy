import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';

import command from '../src/commands/00Overrides/jointocreate.js';

function createClient(configByGuild) {
  return {
    db: {
      get: async key => {
        const match = String(key).match(/^guild:([^:]+):jointocreate$/);
        return match ? structuredClone(configByGuild[match[1]] || null) : null;
      },
      set: async () => true,
    },
    guilds: { cache: new Map(), fetch: async () => null },
  };
}

function createDashboardInteraction(guild, getChannel) {
  let payload = null;
  const message = {
    components: [],
    edit: async data => { payload = data; return message; },
    createMessageComponentCollector: () => ({ on: () => {} }),
  };

  const interaction = {
    id: 'interaction',
    user: { id: 'user' },
    member: { permissions: { has: () => true } },
    guild,
    deferred: true,
    replied: false,
    options: {
      getSubcommand: () => 'dashboard',
      getChannel,
    },
    editReply: async data => { payload = data; return message; },
    fetchReply: async () => message,
  };

  return { interaction, getPayload: () => payload };
}

test('JoinToCreate dashboard keeps every voice channel selectable without mutating interaction options', async () => {
  const guild = { id: 'guild-a', channels: { cache: new Map(), fetch: async () => null } };
  const selected = { id: 'voice-a', type: ChannelType.GuildVoice, guild, toString: () => '<#voice-a>' };
  const originalGetChannel = () => selected;
  const { interaction, getPayload } = createDashboardInteraction(guild, originalGetChannel);
  const client = createClient({
    'guild-a': {
      triggerChannels: ['configured-trigger'],
      channelOptions: { 'voice-a': { nameTemplate: '{username} selected', userLimit: 0, bitrate: 64000 } },
    },
  });

  const dashboardJson = command.data.toJSON().options.find(option => option.name === 'dashboard');
  const channelOption = dashboardJson.options.find(option => option.name === 'trigger_channel');
  assert.equal(channelOption.required, false);
  assert.ok(channelOption.channel_types.includes(ChannelType.GuildVoice));

  await command.execute(interaction, {}, client);

  assert.equal(interaction.options.getChannel, originalGetChannel, 'dashboard must never monkey-patch the real Discord interaction');
  assert.match(getPayload().embeds[0].data.description, /<#voice-a>/);
  assert.equal(getPayload().embeds[0].data.fields[0].value, '`{username} selected`');
});

test('JoinToCreate dashboard still falls back to the persisted active trigger when no channel is selected', async () => {
  const guild = { id: 'guild-b', channels: { cache: new Map(), fetch: async id => guild.channels.cache.get(id) || null } };
  const configured = { id: 'voice-b', type: ChannelType.GuildVoice, guild, toString: () => '<#voice-b>' };
  guild.channels.cache.set(configured.id, configured);

  const originalGetChannel = () => null;
  const { interaction, getPayload } = createDashboardInteraction(guild, originalGetChannel);
  const client = createClient({
    'guild-b': {
      triggerChannels: ['voice-b'],
      channelOptions: { 'voice-b': { nameTemplate: '{username} persisted', userLimit: 0, bitrate: 64000 } },
    },
  });

  await command.execute(interaction, {}, client);

  assert.equal(interaction.options.getChannel, originalGetChannel);
  assert.match(getPayload().embeds[0].data.description, /<#voice-b>/);
  assert.equal(getPayload().embeds[0].data.fields[0].value, '`{username} persisted`');
});
