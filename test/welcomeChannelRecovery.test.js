import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType } from 'discord.js';
import { resolveConfiguredWelcomeChannel } from '../src/events/guildMemberAdd.js';
import { resolveCloudyChannel } from '../src/services/cloudyChannelResolver.js';

test('welcome uses an uncached configured channel before considering recovery', async () => {
  const channel = { id: 'configured' };
  const guild = { channels: { cache: new Map(), fetch: async id => {
    assert.equal(id, channel.id);
    return channel;
  } } };
  assert.equal(await resolveConfiguredWelcomeChannel(guild, channel.id), channel);
});

test('deleted welcome channel allows recovery, transient errors do not redirect it', async () => {
  const guild = { channels: { cache: new Map(), fetch: async () => { throw { code: 10003 }; } } };
  assert.equal(await resolveConfiguredWelcomeChannel(guild, 'deleted'), null);
  guild.channels.fetch = async () => { throw new Error('temporary outage'); };
  await assert.rejects(resolveConfiguredWelcomeChannel(guild, 'configured'), /temporary outage/);
});

test('channel resolver rejects a legacy channel of the wrong type and finds the restored channel', async () => {
  const legacy = { id: '1533189582064062564', type: ChannelType.GuildVoice, isTextBased: () => false };
  const restored = { id: 'restored', name: '📜│rules', type: ChannelType.GuildText, isTextBased: () => true };
  const guild = { id: 'guild', channels: { cache: new Collection([[legacy.id, legacy], [restored.id, restored]]),
    fetch: async () => null } };
  assert.equal(await resolveCloudyChannel({}, 'rules', { guild, textOnly: true }), restored);
});
