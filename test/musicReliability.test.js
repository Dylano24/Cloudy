import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection } from 'discord.js';
import { playQuery, applyPause, applyResume, skipCurrentTrack, destroyPlayerSession, playPreviousTrack } from '../src/services/music/musicActions.js';
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
  const records = [];
  const channel = {
    id: 'panel-channel', isTextBased: () => true,
    messages: {
      cache: new Collection(),
      fetch: async () => ({ edit: async payload => { edits.push(payload); } }),
      edit: async (id, payload) => { records.push({ id, title: payload.embeds[0].toJSON().title, components: payload.components }); },
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
  return { client, player, channel, sent, edits, records };
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

test('a restart turns the player panel into the song\'s Stopped record and ends the session', async () => {
  const f = panelFixture('reliability-shutdown');
  markTrackStarted(f.player);
  await refreshPlayerMessage(f.client, 'reliability-shutdown');
  await shutdownMusic(f.client);
  assert.deepEqual(f.records.map(r => [r.id, r.title, r.components.length]), [['panel-1', 'Stopped', 0]], 'no dead buttons stay behind');
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

// The real event wiring: Riffy events from Lavalink drive the panels.
function liveFixture(guildId) {
  const f = panelFixture(guildId);
  const riffy = new EventEmitter();
  riffy.players = f.client.riffy.players;
  f.client.riffy = riffy;
  setupPlayerHandler(f.client);
  return f;
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('a finished song stays as Played, a skipped one as Skipped, and the next song gets its own player', async () => {
  const f = liveFixture('records-flow');
  const first = f.player.current;
  f.client.riffy.emit('trackStart', f.player, first);
  await settle(); await settle();
  assert.equal(f.sent.length, 1, 'one player panel for the first song');

  // Skip: Riffy's stop() makes the node report the end with reason "stopped".
  skipCurrentTrack(f.player, getGuildMusicData('records-flow'));
  const second = song('second');
  f.player.current = second;
  f.client.riffy.emit('trackEnd', f.player, first, { reason: 'stopped' });
  await settle(); await settle();
  f.client.riffy.emit('trackStart', f.player, second);
  await settle(); await settle();
  assert.deepEqual(f.records.map(r => [r.id, r.title, r.components.length]), [['panel-1', 'Skipped', 0]]);
  assert.equal(f.sent.length, 2, 'the next song has a new player panel under the record');

  // The last song plays out: Riffy only emits queueEnd.
  f.player.previous = second;
  f.player.playing = false;
  f.client.riffy.emit('queueEnd', f.player);
  await settle(); await settle();
  assert.deepEqual(f.records.map(r => r.title), ['Skipped', 'Played']);
  assert.equal(getGuildMusicData('records-flow').playerMessageId, null);
  deleteGuildMusicData('records-flow');
});

test('Stop leaves nothing old: the panel, the records and an old panel go; a song that could not be loaded shows Could not play', async () => {
  const { buildNowPlayingEmbed, buildMusicRequestEmbed, buildMusicGuideEmbed } = await import('../src/services/music/musicEmbeds.js');
  const f = liveFixture('records-stop');
  f.client.user = { id: 'cloudy' };
  f.client.riffy.emit('trackStart', f.player, f.player.current);
  await settle(); await settle();
  const removed = [];
  const message = (id, embed, author = 'cloudy') => ({ id, author: { id: author }, embeds: [embed], delete: async () => { removed.push(id); } });
  const channelMessages = new Collection([
    ['panel-1', message('panel-1', buildNowPlayingEmbed(f.player.current, f.player, {}))],
    ['played', message('played', buildMusicRequestEmbed(song('earlier'), { playNow: true }).setTitle('Played'))],
    ['old-panel', message('old-panel', buildNowPlayingEmbed(song('old'), { paused: true, queue: [] }, {}))],
    ['guide', message('guide', buildMusicGuideEmbed())],
    ['member', message('member', buildNowPlayingEmbed(song('copy'), f.player, {}), 'someone')],
  ]);
  const fetchOne = f.channel.messages.fetch;
  f.channel.messages.fetch = async options => (options && typeof options === 'object' ? channelMessages : fetchOne(options));
  await destroyPlayerSession(f.client, 'records-stop', f.player, getGuildMusicData('records-stop'));
  assert.deepEqual(removed.sort(), ['old-panel', 'panel-1', 'played'], 'only Cloudy\'s own player messages, the guide stays');
  assert.equal(f.player.destroyed, true);
  deleteGuildMusicData('records-stop');

  const g = liveFixture('records-failed');
  g.client.riffy.emit('trackStart', g.player, g.player.current);
  await settle(); await settle();
  g.client.riffy.emit('trackEnd', g.player, g.player.current, { reason: 'loadFailed' });
  await settle(); await settle();
  assert.deepEqual(g.records.map(r => r.title), ['Could not play']);
  deleteGuildMusicData('records-failed');
});

test('a song on repeat keeps its player panel', async () => {
  const f = liveFixture('records-repeat');
  f.client.riffy.emit('trackStart', f.player, f.player.current);
  await settle(); await settle();
  f.player.loop = 'track';
  f.client.riffy.emit('trackEnd', f.player, f.player.current, { reason: 'finished' });
  await settle(); await settle();
  assert.equal(f.records.length, 0);
  assert.equal(getGuildMusicData('records-repeat').playerMessageId, 'panel-1');
  deleteGuildMusicData('records-repeat');
});

test('30 seconds after the queue ends the bot leaves, although Riffy keeps the last song as current', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = liveFixture('records-idle');
  f.player.previous = f.player.current;
  f.player.playing = false;
  f.client.riffy.emit('queueEnd', f.player);
  await settle(); await settle();
  t.mock.timers.tick(30_000);
  assert.equal(f.player.destroyed, true);
  deleteGuildMusicData('records-idle');
});

test('the music player panel and its records are kept out of every saved response template', async () => {
  const { isMusicPlayerEmbed } = await import('../src/services/music/musicPanelIdentity.js');
  const { buildNowPlayingEmbed, buildMusicRequestEmbed } = await import('../src/services/music/musicEmbeds.js');
  const { applySavedResponsePayloadTemplates } = await import('../src/events/fullResponseCatalogReady.js');
  const { db } = await import('../src/utils/database.js');
  const track = { info: { title: 'Shotta\'s.', author: 'Season 25', length: 142_000, artworkUrl: 'https://i.ytimg.com/vi/x/hq.jpg', requester: { username: 'megadawg' } } };
  const panel = buildNowPlayingEmbed(track, { position: 0, queue: [] }, { loop: 'none' }).toJSON();
  const record = buildMusicRequestEmbed(track, { playNow: true }).setTitle('Skipped').toJSON();
  assert.equal(isMusicPlayerEmbed(panel), true);
  assert.equal(isMusicPlayerEmbed(record), true);
  assert.equal(isMusicPlayerEmbed({ title: 'Stopped', description: 'Playback stopped.', footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' } }), false, 'a plain status reply keeps the normal rules');
  assert.equal(isMusicPlayerEmbed({ title: 'Now playing', fields: [{ name: 'Requested by', value: 'x' }] }), false, 'only Cloudy\'s own panel');
  const { buildQueueEmbed, buildMusicCommandsEmbed } = await import('../src/services/music/musicEmbeds.js');
  assert.equal(isMusicPlayerEmbed(buildQueueEmbed([track], track, 0)), true, 'the Queue button reply');
  assert.equal(isMusicPlayerEmbed(buildMusicCommandsEmbed()), true, 'the Commands explanation');
  assert.equal(isMusicPlayerEmbed({ title: 'Playlists', description: 'x', footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' } }), true, 'the Playlists panel');
  assert.equal(isMusicPlayerEmbed({ title: 'Your list', description: 'x', footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' } }), true, 'the notice of the Add form');

  // Like Cloudy Inc.: a saved "Now playing" template with a green side line and no picture.
  const green = { title: 'Now playing', description: '{dynamic}', color: 0x00C49D, fields: [] };
  const stored = new Map([['cloudy:embed-template:cloudy-inc:__global__', { 'now playing': green, 'other reply': { ...green, title: 'Other reply' } }]]);
  db.initialized = true; db.useFallback = false; db.connectionType = 'test';
  db.db = { get: async key => structuredClone(stored.get(key) ?? null), set: async () => true, delete: async () => true, list: async () => [] };
  const other = { title: 'Other reply', description: 'x', color: 0xFFFFFF };
  const out = await applySavedResponsePayloadTemplates({ embeds: [panel, other] }, { guildId: 'cloudy-inc', channelId: 'music' });
  assert.equal(out.embeds[0], panel, 'the panel is sent exactly as built');
  assert.equal(out.embeds[0].color, 0xFFFFFF, 'white side line, as in Dylano');
  assert.equal(out.embeds[0].image.url, track.info.artworkUrl, 'the cover stays');
  assert.equal(out.embeds[1].color, 0x00C49D, 'other replies still follow their saved template');
});

test('Previous plays the song before, this song waits after it; with nothing earlier the song starts again', () => {
  const player = makePlayer();
  const first = song('first');
  const second = song('second');
  const third = song('third');
  player.current = second;
  player.queue.add(third);
  player.seek = position => { player.seekedTo = position; };
  const data = getGuildMusicData('reliability-previous');
  data.previousTracks = [first];
  assert.equal(playPreviousTrack(player, data), true);
  assert.deepEqual(player.queue.map(item => item.info.title), ['first', 'second', 'third']);
  assert.equal(player.stops, 1);
  assert.equal(data.goingBack, true);
  assert.equal(playPreviousTrack(player, data), false, 'a double click goes back once');

  const alone = makePlayer();
  alone.current = song('only');
  alone.seek = position => { alone.seekedTo = position; };
  const fresh = getGuildMusicData('reliability-previous-alone');
  assert.equal(playPreviousTrack(alone, fresh), true);
  assert.equal(alone.seekedTo, 0);
  assert.equal(alone.stops, 0);
  deleteGuildMusicData('reliability-previous');
  deleteGuildMusicData('reliability-previous-alone');
});

test('going back adds nothing to the history, so Previous can go back further', async () => {
  const f = liveFixture('reliability-history');
  const a = song('a');
  const b = song('b');
  f.player.current = b;
  f.player.previous = a;
  f.client.riffy.emit('trackStart', f.player, b);
  await settle(); await settle();
  const data = getGuildMusicData('reliability-history');
  assert.deepEqual(data.previousTracks.map(item => item.info.title), ['a']);
  data.goingBack = true;
  f.player.current = a;
  f.player.previous = b;
  f.client.riffy.emit('trackStart', f.player, a);
  await settle(); await settle();
  assert.deepEqual(data.previousTracks.map(item => item.info.title), ['a'], 'the song left behind is not added');
  assert.equal(data.goingBack, false);
  deleteGuildMusicData('reliability-history');
});

test('a playlist added while a song plays shows in the player panel at once', async () => {
  const f = panelFixture('reliability-playlist-now');
  markTrackStarted(f.player);
  await refreshPlayerMessage(f.client, 'reliability-playlist-now');
  f.client.riffy.resolve = async () => ({ loadType: 'playlist', playlistInfo: { name: 'Mix' }, tracks: [song('a'), song('b'), song('c')] });
  const interaction = { guild: { id: 'reliability-playlist-now' }, channel: { id: 'panel-channel' }, user: { id: 'u' }, member: { voice: { channel: { id: 'voice' } } } };
  await playQuery(f.client, interaction, 'https://open.spotify.com/playlist/x');
  const queueField = f.edits.at(-1).embeds[0].toJSON().fields.find(field => field.name === 'Queue');
  assert.equal(queueField.value, '3 tracks', 'not only after the next 15-second refresh');
  deleteGuildMusicData('reliability-playlist-now');
});

test('a new player plays at volume 100, the song\'s own sound that the node passes through unchanged', async () => {
  const player = makePlayer();
  const volumes = [];
  player.setVolume = volume => { volumes.push(volume); };
  const { client, interaction } = setup('quality-volume', player);
  await playQuery(client, interaction, 'first');
  assert.equal(getGuildMusicData('quality-volume').volume, 100);
  assert.deepEqual([...new Set(volumes)], [100]);
  deleteGuildMusicData('quality-volume');
});

test('the bar timer fires when the bar reaches its next piece, not up to 15 seconds later', async () => {
  const { msUntilNextBarPiece } = await import('../src/services/music/musicEmbeds.js');
  const { nextBarRefreshDelay } = await import('../src/services/music/playerHandler.js');
  const at = (position, extra = {}) => ({ current: song('x'), position, cloudyPositionAt: 1_000, paused: false, ...extra });
  assert.equal(msUntilNextBarPiece(at(0), 1_000), 9_000, 'a 3-minute song gets its first piece after 9 seconds');
  assert.equal(msUntilNextBarPiece(at(10_000), 1_000), 17_000);
  assert.equal(msUntilNextBarPiece(at(10_000, { paused: true }), 1_000), null, 'nothing moves while paused');
  assert.equal(msUntilNextBarPiece(at(179_000), 1_000), null, 'a full bar');
  assert.equal(nextBarRefreshDelay(at(0), 1_000), 9_250);
  assert.equal(nextBarRefreshDelay(at(10_000), 1_000), 15_000, 'at least every 15 seconds');
  assert.equal(nextBarRefreshDelay(at(8_990), 1_000), 2_000, 'never more often than every 2 seconds');
  assert.equal(nextBarRefreshDelay(at(0, { paused: true }), 1_000), 15_000);
});

test('the player panel is edited exactly when the bar moves, and not in between', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const f = liveFixture('quality-bar');
  const flush = async () => { for (let i = 0; i < 6; i += 1) await settle(); };
  f.client.riffy.emit('trackStart', f.player, f.player.current);
  await flush();
  assert.equal(f.sent.length, 1);
  t.mock.timers.tick(9_000);
  await flush();
  assert.equal(f.edits.length, 0, 'the first piece is not due yet');
  t.mock.timers.tick(300);
  await flush();
  assert.equal(f.edits.length, 1, 'edited right when the first piece fills');
  t.mock.timers.tick(15_000);
  await flush();
  assert.equal(f.edits.length, 1, 'the 15-second check sends nothing while the bar did not move');
  t.mock.timers.tick(3_000);
  await flush();
  assert.equal(f.edits.length, 2, 'the second piece right on time');
  deleteGuildMusicData('quality-bar');
});

test('Pause, Resume and Loop on the player are answered with the new panel in one step', async () => {
  const { musicButtonHandler } = await import('../src/handlers/musicButtons.js');
  const f = panelFixture('quality-click');
  f.player.voiceChannel = 'voice';
  f.player.queue.shuffle = () => {};
  markTrackStarted(f.player);
  await refreshPlayerMessage(f.client, 'quality-click');
  assert.equal(f.sent.length, 1);
  const answers = [];
  const click = (customId, messageId = 'panel-1') => ({
    customId, guild: { id: 'quality-click' }, user: { id: 'member' }, message: { id: messageId },
    member: { voice: { channel: { id: 'voice' } } },
    deferred: false, replied: false, deferrals: 0,
    async update(payload) { this.replied = true; answers.push(payload); },
    async deferUpdate() { this.deferred = true; this.deferrals += 1; },
  });
  const ids = payload => payload.components.flatMap(row => row.toJSON().components.map(button => button.custom_id));

  const pause = click('music_pause');
  await musicButtonHandler.execute(pause, f.client);
  assert.deepEqual(f.player.pauses, [true]);
  assert.equal(answers.length, 1);
  assert.equal(pause.deferrals, 0, 'no acknowledgement before the answer');
  assert.ok(ids(answers[0]).includes('music_resume'), 'the answer already shows Resume');
  assert.equal(f.edits.length, 0, 'no second edit of the panel');

  await musicButtonHandler.execute(click('music_resume'), f.client);
  assert.equal(f.player.playing, true);
  assert.ok(ids(answers[1]).includes('music_pause'));
  await musicButtonHandler.execute(click('music_loop'), f.client);
  assert.equal(getGuildMusicData('quality-click').loop, 'track');
  assert.equal(answers.length, 3);
  assert.equal(f.edits.length, 0);

  const old = click('music_pause', 'some-old-message');
  await musicButtonHandler.execute(old, f.client);
  assert.equal(old.deferrals, 1, 'a click elsewhere is acknowledged');
  assert.equal(f.edits.length, 1, 'and the panel itself is edited');
  deleteGuildMusicData('quality-click');
});

test('/play while a song runs always queues, also when Riffy says it is not playing', async () => {
  const f = liveFixture('busy-play');
  f.player.queue.length = 0;
  f.client.riffy.createConnection = () => f.player;
  f.client.riffy.resolve = async ({ query }) => ({ loadType: 'track', tracks: [song(query)] });
  f.client.riffy.emit('trackStart', f.player, f.player.current);
  await settle(); await settle();
  // A voice reconnect left the flag wrong while the song still runs.
  f.player.playing = false;
  const interaction = {
    guild: { id: 'busy-play', members: { me: {} } }, channel: { id: 'panel-channel' }, user: { id: 'member' },
    member: { voice: { channel: { id: 'voice', name: 'General', permissionsFor: () => ({ has: () => true }) } } },
  };
  const result = await playQuery(f.client, interaction, 'next one');
  assert.equal(result.embed.toJSON().title, 'Added to queue');
  assert.equal(f.player.plays, 0, 'the running song was not replaced');
  assert.deepEqual(f.player.queue.map(t => t.info.title), ['next one']);
  deleteGuildMusicData('busy-play');
});
