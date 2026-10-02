import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import handler from '../src/events/voiceStateUpdate.js';

let sequence = 0;
function fixture({ moveFails = false, deleteFails = false, registrationFails = false } = {}) {
  const guild = { id: `voice-test-${++sequence}`, name: 'Guild', maximumBitrate: 96000,
    members: { me: {} }, channels: { cache: new Collection() } };
  let config = { enabled: true, triggerChannels: ['trigger', 'trigger2'],
    temporaryChannels: {}, bitrate: 384000, channelNameTemplate: "{username}'s Room" };
  const client = { config: {}, db: {
    get: async () => structuredClone(config),
    set: async (_key, value) => {
      if (registrationFails) throw new Error('storage unavailable');
      config = structuredClone(value);
    },
  } };
  const trigger = { id: 'trigger', name: 'Create', parentId: null, permissionsFor: () => ({ has: () => true }) };
  const member = { id: 'owner', user: { bot: false, username: 'Owner', tag: 'Owner' },
    displayName: 'Owner', send: async () => {}, voice: { channel: trigger,
      setChannel: async channel => {
        if (moveFails) throw new Error('move denied');
        member.voice.channel = channel;
        channel.members.set(member.id, member);
      },
    } };
  const created = [];
  guild.channels.create = async options => {
    const channel = { id: `temp-${created.length}`, name: options.name, guild, members: new Collection(),
      delete: async () => {
        if (deleteFails) throw new Error('delete denied');
        channel.deleted = true;
        guild.channels.cache.delete(channel.id);
      },
    };
    guild.channels.cache.set(channel.id, channel);
    created.push({ channel, options });
    return channel;
  };
  const state = channel => ({ guild, member, channel });
  return { guild, client, member, trigger, created, state,
    config: () => config,
    join: () => handler.execute(state(null), state(trigger), client) };
}

test('join clamps bitrate to guild maximum and concurrent events create only one room', async () => {
  const f = fixture();
  await Promise.all([f.join(), f.join()]);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].options.bitrate, 96000);
  assert.equal(Object.keys(f.config().temporaryChannels).length, 1);
});

test('moving between trigger channels still creates a room', async () => {
  const f = fixture();
  await handler.execute(f.state({ id: 'trigger2' }), f.state(f.trigger), f.client);
  assert.equal(f.created.length, 1);
});

test('join uses the current Discord channel name while keeping trigger matching ID based', async () => {
  const f = fixture();
  f.config().channelNameTemplate = '{channelName}';
  f.guild.channels.fetch = async (channelId, options) => {
    assert.equal(channelId, f.trigger.id);
    assert.deepEqual(options, { force: true });
    return {
      ...f.trigger,
      name: 'Renamed Create',
    };
  };

  await f.join();

  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].options.name, 'Renamed Create');
  assert.ok(f.config().triggerChannels.includes(f.trigger.id));
});

test('failed move removes the empty new room and its registration', async () => {
  const f = fixture({ moveFails: true });
  await f.join();
  assert.equal(f.created[0].channel.deleted, true);
  assert.deepEqual(f.config().temporaryChannels, {});
});

test('failed persistence removes the empty Discord room instead of moving the member', async () => {
  const f = fixture({ registrationFails: true });
  await f.join();
  assert.equal(f.created[0].channel.deleted, true);
  assert.equal(f.member.voice.channel.id, 'trigger');
});

test('failed Discord deletion preserves registration for retry', async () => {
  const f = fixture({ deleteFails: true });
  await f.join();
  const channel = f.created[0].channel;
  channel.members.clear();
  await handler.execute(f.state(channel), f.state(null), f.client);
  assert.ok(f.config().temporaryChannels[channel.id]);
});

test('disabling creation still cleans up existing empty rooms', async () => {
  const f = fixture();
  await f.join();
  const channel = f.created[0].channel;
  channel.members.clear();
  f.config().enabled = false;
  f.config().triggerChannels = [];
  await handler.execute(f.state(channel), f.state(null), f.client);
  assert.equal(channel.deleted, true);
  assert.deepEqual(f.config().temporaryChannels, {});
});

test('leaving while the Discord create request is pending does not leave an empty room', async () => {
  const f = fixture();
  const create = f.guild.channels.create;
  f.guild.channels.create = async options => {
    const channel = await create(options);
    f.member.voice.channel = null;
    return channel;
  };
  await f.join();
  assert.equal(f.created[0].channel.deleted, true);
  assert.deepEqual(f.config().temporaryChannels, {});
});
