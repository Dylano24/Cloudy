import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PermissionFlagsBits } from 'discord.js';
import { playQuery, waitForMusicReady } from '../src/services/music/musicActions.js';
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

test('when Discord sent the voice details but the node cannot use them, the same player moves to the other node', async () => {
  const nodeA = { name: 'A-move', rest: { destroyed: 0, destroyPlayer() { this.destroyed += 1; return Promise.resolve(); } } };
  const nodeB = { name: 'B-move', rest: {} };
  let plays = 0;
  const player = makePlayer(async function play() {
    plays += 1;
    if (plays === 1) return false;
    this.playing = true;
    return this;
  });
  player.guildId = 'voice-move';
  player.voiceChannel = 'voice';
  const sent = [];
  player.connection = {
    voice: { sessionId: 's', endpoint: 'rotterdam123.discord.media', token: 't' },
    pendingUpdate: 'unanswered',
    establishing: true,
    updatePlayerVoiceData: async data => { sent.push({ node: player.node.name, data }); },
  };
  const { client, interaction } = setup('voice-move', player);
  client.riffy.leastUsedNodes = [nodeA, nodeB];
  const created = [];
  client.riffy.createPlayer = node => { created.push(node.name); player.node = node; return player; };
  const { embed } = await playQuery(client, interaction, 'some song');
  assert.deepEqual(created, ['A-move'], 'the player is created once: nobody leaves and joins again');
  assert.equal(player.node, nodeB);
  assert.deepEqual(sent, [{ node: 'B-move', data: { sessionId: 's', endpoint: 'rotterdam123.discord.media', token: 't', channelId: 'voice' } }]);
  assert.equal(nodeA.rest.destroyed, 1, 'the old node is told to let go');
  assert.equal(player.connection.pendingUpdate, null);
  assert.equal(player.destroyed, false);
  assert.equal(player.queue.length, 1, 'the song stays queued for the new node');
  assert.equal(embed.toJSON().title, 'Now playing');

  // The node that failed is tried last for the next /play, so nobody waits for it again.
  const next = makePlayer(async function play() { this.playing = true; return this; });
  const second = setup('voice-move-next', next);
  second.client.riffy.leastUsedNodes = [nodeA, nodeB];
  const createdNext = [];
  second.client.riffy.createPlayer = node => { createdNext.push(node.name); next.node = node; return next; };
  await playQuery(second.client, second.interaction, 'another song');
  assert.deepEqual(createdNext, ['B-move']);
});

test('every node is tried and the message is clear when none can hold the voice connection', async () => {
  const nodeA = { name: 'A-none', rest: { destroyPlayer: async () => {} } };
  const nodeB = { name: 'B-none', rest: { destroyPlayer: async () => {} } };
  const player = makePlayer(async () => false);
  player.guildId = 'voice-none';
  player.voiceChannel = 'voice';
  const sent = [];
  player.connection = {
    voice: { sessionId: 's', endpoint: 'x.discord.media', token: 't' },
    updatePlayerVoiceData: async () => { sent.push(player.node.name); },
  };
  const { client, interaction } = setup('voice-none', player);
  client.riffy.leastUsedNodes = [nodeA, nodeB];
  client.riffy.createPlayer = node => { player.node = node; return player; };
  await assert.rejects(playQuery(client, interaction, 'some song'), error => /could not connect to your voice channel/.test(error.userMessage));
  assert.deepEqual(sent, ['B-none']);
  assert.equal(player.destroyed, true);
});

test('no second try when Discord never sent the voice details', async () => {
  const first = makePlayer(async () => false);
  first.node = { name: 'A' };
  first.connection = { voice: {} };
  const { client, interaction } = setup('voice-no-details', first);
  client.riffy.leastUsedNodes = [first.node, { name: 'B' }];
  let created = 0;
  client.riffy.createPlayer = node => { created += 1; first.node = node; return first; };
  await assert.rejects(playQuery(client, interaction, 'some song'), error => /could not connect to your voice channel/.test(error.userMessage));
  assert.equal(created, 1, 'the player is created once and never moved: there are no voice details to move');
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

test('a bot that Discord still shows in a voice channel leaves it before joining', async () => {
  const order = [];
  const player = makePlayer(async function play() { this.playing = true; return this; });
  const { client, interaction } = setup('voice-stale', player, { permissionsFor: () => ({ has: () => true }) }, { voice: { channelId: 'old-channel' } });
  client.riffy.send = payload => order.push(['send', payload.op, payload.d.channel_id]);
  client.riffy.createConnection = () => { order.push(['join']); return player; };
  const { embed } = await playQuery(client, interaction, 'some song');
  assert.deepEqual(order, [['send', 4, null], ['join']], 'it leaves first, then joins');
  assert.equal(embed.toJSON().title, 'Now playing');
});

test('a bot that is not shown in a voice channel just joins', async () => {
  const order = [];
  const player = makePlayer(async function play() { this.playing = true; return this; });
  const { client, interaction } = setup('voice-clean', player, { permissionsFor: () => ({ has: () => true }) }, { voice: { channelId: null } });
  client.riffy.send = () => order.push('send');
  client.riffy.createConnection = () => { order.push('join'); return player; };
  await playQuery(client, interaction, 'some song');
  assert.deepEqual(order, ['join']);
});

test('a /play right after a restart waits for the music server instead of failing', async () => {
  const player = makePlayer(async function play() { this.playing = true; return this; });
  const { client, interaction } = setup('restart-wait', player, { permissionsFor: () => ({ has: () => true }) }, {});
  client.riffy.initiated = false;
  client.riffy.leastUsedNodes = [];
  setTimeout(() => { client.riffy.initiated = true; client.riffy.leastUsedNodes = [{ name: 'W-ready' }]; }, 400);
  client.riffy.createPlayer = node => { player.node = node; return player; };
  const { embed } = await playQuery(client, interaction, 'some song');
  assert.equal(embed.toJSON().title, 'Now playing');
});

test('when the music server never comes up the message is clear, not "Something went wrong"', async () => {
  const client = { riffy: { initiated: false, players: new Map() } };
  await assert.rejects(waitForMusicReady(client, 300), error => {
    assert.equal(error.name, 'CloudyError');
    assert.equal(error.type, 'network');
    assert.match(error.userMessage, /music server is not responding/);
    return true;
  });
});

test('the same song can be added again, also while it plays or is queued', async () => {
  const player = makePlayer(async function play() { this.playing = true; return this; });
  const { client, interaction } = setup('duplicates', player, { permissionsFor: () => ({ has: () => true }) }, {});
  const first = await playQuery(client, interaction, 'some song');
  assert.equal(first.embed.toJSON().title, 'Now playing');
  const again = await playQuery(client, interaction, 'some song');
  assert.equal(again.embed.toJSON().title, 'Added to queue');
  assert.equal(player.queue.length, 2);

  client.riffy.resolve = async () => ({ loadType: 'playlist', playlistInfo: { name: 'Mix' }, tracks: [{ ...track, info: { ...track.info } }, { ...track, info: { ...track.info } }] });
  const playlist = await playQuery(client, interaction, 'a playlist');
  assert.match(playlist.embed.toJSON().description, /Added 2 track\(s\)\./);
  assert.doesNotMatch(playlist.embed.toJSON().description, /duplicate/i);
  assert.equal(player.queue.length, 4);
});

test('a search that one node cannot answer is answered by the other node', async () => {
  const nodeA = { name: 'A-search' };
  const nodeB = { name: 'B-search' };
  const player = makePlayer(async function play() { this.playing = true; return this; });
  const { client, interaction } = setup('search-fallback', player, { permissionsFor: () => ({ has: () => true }) }, {});
  client.riffy.leastUsedNodes = [nodeA, nodeB];
  client.riffy.createPlayer = node => { player.node = node; return player; };
  const asked = [];
  client.riffy.resolve = async ({ node }) => {
    asked.push(node.name);
    if (node === nodeA) throw new TypeError('no body');
    return { loadType: 'track', tracks: [{ ...track, info: { ...track.info } }] };
  };
  const { embed } = await playQuery(client, interaction, 'some song');
  assert.deepEqual(asked, ['A-search', 'B-search']);
  assert.equal(embed.toJSON().title, 'Now playing');
});
