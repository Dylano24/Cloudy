import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection } from 'discord.js';
import { playQuery, applyPause, applyResume, skipCurrentTrack } from '../src/services/music/musicActions.js';
import { getGuildMusicData, deleteGuildMusicData } from '../src/services/music/playerStore.js';
import { refreshPlayerMessage, markTrackStarted, setupPlayerHandler, shutdownMusic } from '../src/services/music/playerHandler.js';
import { livePlayerPosition } from '../src/services/music/musicEmbeds.js';
import { applyNodeReconnectBackoff } from '../src/services/music/riffySetup.js';

const song = title => ({ info: { title, author: 'Artist', uri: `https://example.com/${title}`, length: 180_000 } });

function makePlayer() {
  const queue = [];
  queue.add = item => queue.push(item);
  queue.clear = () => { queue.length = 0; };
  return {
    queue, current: null, playing: false, paused: false, position: 0, plays: 0, stops: 0, pauses: [],
    setVolume() {}, setLoop(mode) { this.loop = mode; },
    async play() { this.plays += 1; this.current = queue.shift(); this.playing = true; return this; },
    stop() { this.stops += 1; this.playing = false; },
    // Riffy's own pause: it never sets playing back to true.
    pause(value) { this.pauses.push(value); this.playing = this.playing ? false : this.playing; this.paused = value; },
    destroy() { this.destroyed = true; },
  };
}

function setup(guildId, player) {
  let created = 0;
  const client = {
    channels: { cache: new Map() },
    riffy: {
      players: new Map(),
      createConnection: () => { created += 1; client.riffy.players.set(guildId, player); return player; },
      resolve: async ({ query }) => ({ loadType: 'track', tracks: [song(query)] }),
    },
  };
  const interaction = {
    guild: { id: guildId, members: { me: {} } }, channel: { id: 'text' }, user: { id: 'member' },
    member: { voice: { channel: { id: 'voice', name: 'General', permissionsFor: () => ({ has: () => true }) } } },
  };
  return { client, interaction, created: () => created };
}

test('after Pause and Resume a new /play queues behind the song instead of replacing it', async () => {
  const player = makePlayer();
  const { client, interaction } = setup('reliability-resume', player);
  const first = await playQuery(client, interaction, 'first');
  assert.equal(first.embed.toJSON().title, 'Now playing');
  await applyPause(client, 'reliability-resume');
  await applyResume(client, 'reliability-resume');
  assert.equal(player.playing, true, 'a resumed song counts as playing again');
  const second = await playQuery(client, interaction, 'second');
  assert.equal(second.embed.toJSON().title, 'Added to queue');
  assert.equal(player.plays, 1, 'the playing song was not replaced');
  assert.equal(player.current.info.title, 'first');
  deleteGuildMusicData('reliability-resume');
});

test('two /play commands at the same moment create one player and start one song', async () => {
  const player = makePlayer();
  const { client, interaction, created } = setup('reliability-concurrent', player);
  const [a, b] = await Promise.all([playQuery(client, interaction, 'one'), playQuery(client, interaction, 'two')]);
  assert.equal(created(), 1);
  assert.equal(player.plays, 1);
  assert.deepEqual([a.embed.toJSON().title, b.embed.toJSON().title], ['Now playing', 'Added to queue']);
  assert.equal(player.queue.length, 1);
  deleteGuildMusicData('reliability-concurrent');
});

test('a double click on Skip skips one song; a skip while paused continues with sound', () => {
  const player = makePlayer();
  player.current = song('now');
  const data = getGuildMusicData('reliability-skip');
  assert.equal(skipCurrentTrack(player, data), true);
  assert.equal(skipCurrentTrack(player, data), false);
  assert.equal(player.stops, 1);

  player.current = song('next');
  player.paused = true;
  data.autoPaused = true;
  assert.equal(skipCurrentTrack(player, data), true);
  assert.deepEqual(player.pauses, [false], 'Lavalink is told to continue playing');
  assert.equal(player.paused, false);
  assert.equal(data.autoPaused, false);
  deleteGuildMusicData('reliability-skip');
});

test('the progress bar follows the song between node reports and stops while paused', () => {
  const now = 1_000_000;
  const player = { current: song('x'), position: 30_000, cloudyPositionAt: now - 4_000, paused: false };
  assert.equal(livePlayerPosition(player, now), 34_000);
  player.paused = true;
  assert.equal(livePlayerPosition(player, now), 30_000);
  assert.equal(livePlayerPosition({ current: song('x'), position: 5_000 }, now), 5_000, 'no report yet: last known position');
  assert.equal(livePlayerPosition({ current: song('x'), position: -10, cloudyPositionAt: now + 50 }, now), 0, 'never negative');
});

test('pausing freezes the bar where the song was, resuming continues from there', async () => {
  const player = makePlayer();
  player.current = song('x');
  player.playing = true;
  player.position = 10_000;
  player.cloudyPositionAt = Date.now() - 5_000;
  const client = { channels: { cache: new Map() }, riffy: { players: new Map([['reliability-pause', player]]) } };
  await applyPause(client, 'reliability-pause');
  assert.ok(player.position >= 15_000 && player.position < 16_000, `paused at ${player.position}`);
  const frozen = livePlayerPosition(player, Date.now() + 60_000);
  assert.equal(frozen, player.position);
  await applyResume(client, 'reliability-pause');
  assert.ok(livePlayerPosition(player) - player.position < 1_000, 'the paused time is not counted');
  deleteGuildMusicData('reliability-pause');
});

function panelFixture(guildId) {
  const sent = [];
  const edits = [];
  const channel = {
    id: 'panel-channel', isTextBased: () => true,
    messages: {
      cache: new Collection(),
      fetch: async () => ({ edit: async payload => { edits.push(payload); } }),
      delete: async id => { channel.deleted.push(id); },
    },
    deleted: [],
    send: async payload => { sent.push(payload); return { id: `panel-${sent.length}` }; },
  };
  const player = makePlayer();
  player.current = song('x');
  player.playing = true;
  player.textChannel = channel.id;
  player.guildId = guildId;
  const client = { channels: { cache: new Map([[channel.id, channel]]) }, riffy: { players: new Map([[guildId, player]]) } };
  return { client, player, channel, sent, edits };
}

test('no player panel says Now playing before the node reports that the song started', async () => {
  const f = panelFixture('reliability-started');
  await refreshPlayerMessage(f.client, 'reliability-started');
  assert.equal(f.sent.length, 0);
  markTrackStarted(f.player);
  await refreshPlayerMessage(f.client, 'reliability-started');
  assert.equal(f.sent.length, 1);
  deleteGuildMusicData('reliability-started');
});

test('a refresh that would show the same panel is not sent to Discord again', async () => {
  const f = panelFixture('reliability-unchanged');
  markTrackStarted(f.player);
  f.player.paused = true;
  await refreshPlayerMessage(f.client, 'reliability-unchanged');
  await refreshPlayerMessage(f.client, 'reliability-unchanged');
  await refreshPlayerMessage(f.client, 'reliability-unchanged');
  assert.equal(f.sent.length, 1);
  assert.equal(f.edits.length, 0, 'nothing changed while paused');
  f.player.paused = false;
  await refreshPlayerMessage(f.client, 'reliability-unchanged');
  assert.equal(f.edits.length, 1, 'a real change is still shown');
  deleteGuildMusicData('reliability-unchanged');
});

test('a song that cannot be streamed leaves no public message under the player', () => {
  const sends = [];
  const channel = { id: 'c', send: async payload => { sends.push(payload); } };
  const client = { channels: { cache: new Map([['c', channel]]) }, riffy: new EventEmitter() };
  setupPlayerHandler(client);
  getGuildMusicData('reliability-error').playerChannelId = 'c';
  client.riffy.emit('trackError', { guildId: 'reliability-error', node: { name: 'A' } }, song('broken'), { exception: { message: 'This video is unavailable' } });
  assert.equal(sends.length, 0);
  deleteGuildMusicData('reliability-error');
});

test('a restart removes the player panel and ends the session', async () => {
  const f = panelFixture('reliability-shutdown');
  markTrackStarted(f.player);
  await refreshPlayerMessage(f.client, 'reliability-shutdown');
  await shutdownMusic(f.client);
  assert.deepEqual(f.channel.deleted, ['panel-1']);
  assert.equal(f.player.destroyed, true);
  assert.equal(getGuildMusicData('reliability-shutdown').playerMessageId, null);
  deleteGuildMusicData('reliability-shutdown');
});

test('a node that keeps failing is retried with growing pauses, a rate-limited node waits a minute', () => {
  const riffy = new EventEmitter();
  applyNodeReconnectBackoff(riffy);
  const node = { name: 'N', reconnectTimeout: 10_000 };
  const delays = [];
  for (let i = 0; i < 7; i += 1) {
    riffy.emit('nodeDisconnect', node, { event: 1006 });
    delays.push(node.reconnectTimeout);
  }
  assert.deepEqual(delays, [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  riffy.emit('nodeConnect', node);
  assert.equal(node.reconnectTimeout, 10_000);
  riffy.emit('nodeDisconnect', node, { event: 4000, reason: 'Too many websocket connections attempt for this bot' });
  assert.equal(node.reconnectTimeout, 60_000);
});
