import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType } from 'discord.js';
import { fetchGuildChannels } from '../src/utils/guildChannelFetch.js';
import { resolveCloudyChannel } from '../src/services/cloudyChannelResolver.js';
import { resolveDedicatedChannel } from '../src/services/dedicatedChannelService.js';

test('concurrent lookups share one Discord fetch while later requests stay fresh', async () => {
  let calls = 0, release;
  const guild = { channels: { fetch: () => {
    calls++;
    return new Promise(resolve => { release = resolve; });
  } } };
  const first = fetchGuildChannels(guild), second = fetchGuildChannels(guild);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release('first');
  assert.deepEqual(await Promise.all([first, second]), ['first', 'first']);
  const third = fetchGuildChannels(guild);
  await Promise.resolve();
  assert.equal(calls, 2);
  release('fresh');
  assert.equal(await third, 'fresh');
});

test('failed reads release the request and never mix separate guilds', async () => {
  const error = new Error('Discord unavailable');
  const a = { channels: { fetch: async () => { throw error; } } };
  const b = { channels: { fetch: async () => 'other guild' } };
  const pending = fetchGuildChannels(a);
  assert.equal(fetchGuildChannels(a), pending);
  await assert.rejects(pending, error);
  assert.equal(await fetchGuildChannels(b), 'other guild');
  a.channels.fetch = async () => 'recovered';
  assert.equal(await fetchGuildChannels(a), 'recovered');
});

test('Cloudy and dedicated resolvers share refresh without changing channel selection', async () => {
  let release, calls = 0;
  const channel = { id: 'restored-shop', name: 'shop', type: ChannelType.GuildText, rawPosition: 1, isTextBased: () => true, isSendable: () => true };
  const guild = { id: 'guild', channels: { cache: new Collection(), fetch: async id => {
    if (id) return null;
    calls++;
    await new Promise(resolve => { release = resolve; });
    guild.channels.cache.set(channel.id, channel);
    return guild.channels.cache;
  } } };
  const cloudy = resolveCloudyChannel({}, 'shop', { guild, textOnly: true });
  const dedicated = resolveDedicatedChannel(guild, 'shop');
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([cloudy, dedicated]), [channel, channel]);
});
