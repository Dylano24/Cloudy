import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PermissionFlagsBits } from 'discord.js';
import { playQuery } from '../src/services/music/musicActions.js';
import { setupPlayerHandler } from '../src/services/music/playerHandler.js';

const track = { info: { title: 'Song', author: 'Artist', uri: 'https://example.com/song', length: 1000 } };
function makePlayer(play) {
  const queue = [];
  queue.add = item => queue.push(item);
  queue.clear = () => { queue.length = 0; };
  const player = { queue, playing: false, paused: false, destroyed: false, setVolume() {}, destroy() { this.destroyed = true; }, play };
  return player;
}
function setup(guildId, player, channel = {}, me = null) {
  const created = [];
  const client = { riffy: {
    players: new Map(),
    createConnection: () => { created.push(true); return player; },
    resolve: async () => ({ loadType: 'track', tracks: [{ ...track }] }),
  } };
  const interaction = {
    guild: { id: guildId, members: { me } }, channel: { id: 'text' }, user: { id: 'member' },
    member: { voice: { channel: { id: 'voice', name: 'General', ...channel } } },
  };
  return { client, interaction, created };
}

test('a voice connection that never comes gives a clear message, not "Now playing"', async () => {
  for (const play of [async () => { throw new Error('Player connection is not initiated'); }, async () => false]) {
    const player = makePlayer(play);
    const { client, interaction } = setup('voice-fail-' + String(play).length, player);
    await assert.rejects(playQuery(client, interaction, 'some song'), error => {
      assert.equal(error.name, 'CloudyError');
      assert.match(error.userMessage, /could not connect to your voice channel/);
      return true;
    });
    assert.equal(player.destroyed, true, 'the half-made connection is cleaned up');
    assert.equal(player.queue.length, 0);
  }
});

test('missing voice permissions are named before the bot tries to join', async () => {
  const player = makePlayer(async () => player);
  const permissions = { has: flags => !([].concat(flags).includes(PermissionFlagsBits.Connect)) };
  const { client, interaction, created } = setup('voice-perms', player, { permissionsFor: () => permissions }, {});
  await assert.rejects(playQuery(client, interaction, 'some song'), error => {
    assert.equal(error.type, 'permission');
    assert.match(error.userMessage, /Connect and Speak permissions in \*\*General\*\*/);
    return true;
  });
  assert.equal(created.length, 0, 'the bot never joined');
});

test('a full voice channel is reported', async () => {
  const player = makePlayer(async () => player);
  const permissions = { has: flags => ![].concat(flags).includes(PermissionFlagsBits.MoveMembers) };
  const { client, interaction } = setup('voice-full', player, { userLimit: 2, members: { size: 2 }, permissionsFor: () => permissions }, {});
  await assert.rejects(playQuery(client, interaction, 'some song'), error => /is full/.test(error.userMessage));
});

test('a song that starts normally is unaffected', async () => {
  const player = makePlayer(async function play() { this.playing = true; return this; });
  const { client, interaction } = setup('voice-ok', player, { permissionsFor: () => ({ has: () => true }) }, {});
  const { embed } = await playQuery(client, interaction, 'some song');
  assert.equal(embed.toJSON().title, 'Now playing');
});

test('play() answers false instead of rejecting where nobody awaits it', async () => {
  const client = { channels: { cache: new Map() }, riffy: new EventEmitter() };
  setupPlayerHandler(client);
  const player = { guildId: 'g', play: async () => { throw new Error('Player connection is not initiated'); } };
  client.riffy.emit('playerCreate', player);
  assert.equal(await player.play(), false);
});

test('when Discord sent the voice details but the node cannot use them, the other node is tried', async () => {
  const nodeA = { name: 'A' };
  const nodeB = { name: 'B' };
  const first = makePlayer(async () => false);
  first.node = nodeA;
  first.connection = { voice: { sessionId: 's', endpoint: 'rotterdam123.discord.media', token: 't' } };
  const second = makePlayer(async function play() { this.playing = true; return this; });
  const { client, interaction } = setup('voice-failover', first);
  client.riffy.leastUsedNodes = [nodeA, nodeB];
  const created = [];
  client.riffy.createPlayer = node => { created.push(node.name); second.node = node; return second; };
  const { embed } = await playQuery(client, interaction, 'some song');
  assert.deepEqual(created, ['B']);
  assert.equal(first.destroyed, true, 'the failed connection is dropped');
  assert.equal(second.queue.length, 1, 'the song moved to the new connection');
  assert.equal(embed.toJSON().title, 'Now playing');
});

test('no second try when Discord never sent the voice details', async () => {
  const first = makePlayer(async () => false);
  first.node = { name: 'A' };
  first.connection = { voice: {} };
  const { client, interaction } = setup('voice-no-details', first);
  client.riffy.leastUsedNodes = [first.node, { name: 'B' }];
  let created = 0;
  client.riffy.createPlayer = () => { created += 1; return makePlayer(async () => true); };
  await assert.rejects(playQuery(client, interaction, 'some song'), error => /could not connect to your voice channel/.test(error.userMessage));
  assert.equal(created, 0);
  assert.equal(first.destroyed, true);
});

test('the bot\'s own member is fetched when it is not cached, so the permission check always runs', async () => {
  const player = makePlayer(async () => player);
  const permissions = { has: flags => ![].concat(flags).includes(PermissionFlagsBits.Connect) };
  const { client, interaction, created } = setup('voice-fetchme', player, { permissionsFor: () => permissions }, null);
  interaction.guild.members = { me: null, fetchMe: async () => ({}) };
  await assert.rejects(playQuery(client, interaction, 'some song'), error => error.type === 'permission');
  assert.equal(created.length, 0);
});
