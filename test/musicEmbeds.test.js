import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import { buildNowPlayingEmbed, buildQueueEmbed, buildMusicGuideEmbed, buildMusicCommandsEmbed, buildMusicRequestEmbed, formatMusicProgress, getTrackArtwork } from '../src/services/music/musicEmbeds.js';
import { ensureWhiteMusicEmbeds } from '../src/utils/cloudyFooter.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';
import playCommand from '../src/commands/Music/play.js';
import nowCommand from '../src/commands/Music/now.js';
import nowplayingCommand from '../src/commands/Music/nowplaying.js';
import queueCommand from '../src/commands/Music/queue.js';
import musicCommand from '../src/commands/Music/music.js';
import { refreshPlayerMessage } from '../src/services/music/playerHandler.js';
import { deleteGuildMusicData, getGuildMusicData } from '../src/services/music/playerStore.js';

const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const track = { info: { title: 'Song', author: 'Artist', length: 180_000, artworkUrl: 'https://i.ytimg.com/vi/x/hq.jpg', requester: { username: 'Dawg' } } };

test('now playing: sentence-case title, Cloudy logo and footer, cover art as image, status as a field', () => {
  const embed = buildNowPlayingEmbed(track, { position: 60_000, paused: true, queue: [track] }, { volume: 80, loop: 'none' }).toJSON();
  assert.equal(embed.title, 'Now playing');
  // The progress bar sits in the text on its own line, ten pieces, and there is no "position / length" text
  // (plain blocks until the white pieces are uploaded).
  assert.equal(embed.description, '**Song**\n\n▰▰▰▱▱▱▱▱▱▱');
  assert.equal(buildNowPlayingEmbed({ info: { ...track.info, length: 0 } }, { position: 0, queue: [] }, {}).toJSON().description, '**Song**');
  assert.match(embed.thumbnail.url, /cloudy-music-icon\.png/);
  assert.equal(embed.color, 0xFFFFFF);
  assert.equal(embed.image.url, 'https://i.ytimg.com/vi/x/hq.jpg');
  assert.equal(embed.footer.text, FOOTER);
  assert.deepEqual(embed.fields.map(field => [field.name, field.value]), [
    ['Artist', 'Artist'], ['Requested by', 'Dawg'], ['Status', 'Paused'], ['Loop', 'Off'], ['Queue', '1 track'],
  ]);
});

test('queue: sentence-case title, page line in the text, Cloudy logo and footer', () => {
  const embed = buildQueueEmbed([track, track], track, 0).toJSON();
  assert.equal(embed.title, 'Music queue');
  assert.match(embed.description, /^\*\*Now playing\*\*\nSong — Artist\n\n1\. Song — Artist\n2\. Song — Artist\n\nPage 1 of 1 · 2 queued$/);
  assert.match(embed.thumbnail.url, /cloudy-c-logo/);
  assert.equal(embed.footer.text, FOOTER);
});

test('a new player panel goes to #music; an existing panel keeps its message', async () => {
  const guildId = 'music-panel-guild';
  const sent = [];
  const channel = (id, name) => ({ id, name, type: ChannelType.GuildText, isTextBased: () => true,
    messages: { cache: new Collection(), fetch: async () => null },
    send: async payload => { sent.push({ channel: name, payload }); return { id: 'panel-' + sent.length }; } });
  const music = channel('music-channel', '🎧│music');
  const general = channel('general-channel', '💬│general');
  const player = { current: track, paused: false, position: 0, textChannel: general.id, queue: [] };
  const client = {
    channels: { cache: new Collection([[music.id, music], [general.id, general]]) },
    guilds: { cache: new Collection([[guildId, { id: guildId, channels: { cache: new Collection([[music.id, music], [general.id, general]]) } }]]) },
    riffy: { players: new Map([[guildId, player]]) },
  };
  const data = getGuildMusicData(guildId);
  data.playerChannelId = general.id;
  await refreshPlayerMessage(client, guildId);
  assert.deepEqual(sent.map(entry => entry.channel), ['🎧│music']);
  assert.equal(data.playerChannelId, music.id);
  assert.deepEqual(sent[0].payload.allowedMentions, { parse: [] });
  deleteGuildMusicData(guildId);
});

test('public song announcement includes verified artwork, artist, album and queue position', () => {
  const song = { info: { ...track.info, albumName: 'Example album', requester: { username: 'Test user' } } };
  const queued = buildMusicRequestEmbed(song, { queuePosition: 2 }).toJSON();
  assert.equal(queued.title, 'Added to queue');
  assert.equal(queued.image.url, song.info.artworkUrl);
  assert.equal(buildNowPlayingEmbed(song, { position: 0, queue: [] }, {}).toJSON().fields.find(field => field.name === 'Album').value, 'Example album');
  assert.ok(buildMusicRequestEmbed({info: { title: 'Track', author: 'Artist', album: 'String album' }}).toJSON().fields.some(field => field.name === 'Album' && field.value === 'String album'));
  assert.match(queued.description, /\*\*Song\*\*\nArtist/);
  assert.ok(queued.fields.some(field => field.name === 'Album' && field.value === 'Example album'));
  assert.ok(queued.fields.some(field => field.name === 'Queue position' && field.value === '#2'));
  assert.equal(buildMusicRequestEmbed(song, { playNow: true }).toJSON().title, 'Now playing');
  assert.equal(formatMusicProgress(0, 180_000), '▱'.repeat(12));
  assert.equal(formatMusicProgress(180_000, 180_000), '▰'.repeat(12));
  assert.equal(formatMusicProgress(0, 0), null);
});

test('music guide keeps Cloudy branding and the commands explain the player buttons by emoji', () => {
  const guide = buildMusicGuideEmbed().toJSON();
  assert.equal(guide.title, 'Cloudy music');
  assert.match(guide.description, /Click the button below/);
  assert.ok(!guide.description.includes('/now playing'), 'the public panel must remain short');
  const commands = buildMusicCommandsEmbed().toJSON();
  assert.equal(commands.title, 'Music commands');
  // The buttons of the player in their order, one short line each with one emoji, so the lines stay neatly under each other.
  const lines = commands.description.split('\n').filter(line => /^\p{Extended_Pictographic}/u.test(line));
  assert.deepEqual(lines.map(line => line.split(' ')[0]), ['⏸️', '⏭️', '🔀', '🔁', '📋', '🎵', '⏹️']);
  for (const line of lines) {
    assert.ok(line.length <= 26, `Explanation must stay short: ${line}`);
    assert.ok(!line.includes('**') && !line.includes(' — '), `No names or dashes, just the emoji and a few words: ${line}`);
  }
  // /play is the only slash command: the player covers the rest, other commands (such as a future Guess the song) get their own line.
  assert.deepEqual(commands.description.match(/`\/[a-z ]+`/g), ['`/play`']);
  // Every line is short enough to stay on one line next to the thumbnail on a phone.
  for (const line of commands.description.split('\n')) assert.ok(line.length <= 30, `Line too long: ${line}`);
  assert.equal(commands.footer.text, FOOTER);
  assert.match(guide.description, /\/play/);
  assert.equal(guide.footer.text, FOOTER);
  assert.match(guide.thumbnail.url, /cloudy-c-logo/);
  assert.ok(musicCommand.data.toJSON().options.some(o => o.name === 'guide'));
  const now = nowCommand.data.toJSON();
  assert.equal(now.name, 'now');
  assert.ok(now.options.some(o => o.name === 'playing'));
});

test('play slash announcement is public in both guilds, like the original player', async t => {
  let deferOptions = 'not-called';
  let publicReply = null;
  t.mock.method(InteractionHelper, 'safeDefer', async (targetInteraction, options) => {
    deferOptions = options;
    targetInteraction.deferred = true;
    return true;
  });
  t.mock.method(InteractionHelper, 'safeEditReply', async (_interaction, payload) => {
    publicReply = payload;
    return true;
  });
  const currentTrack = { info: { ...track.info, albumName: 'Example album' } };
  const queue = [];
  queue.add = entry => queue.push(entry);
  const player = {
    current: null, playing: false, paused: false, queue, voiceChannel: 'voice-channel',
    setVolume() {}, play() { this.playing = true; },
  };
  const client = {
    riffy: {
      players: new Map([['test-music-server', player]]),
      resolve: async () => ({ loadType: 'track', tracks: [currentTrack] }),
    },
  };
  const interaction = {
    guild: { id: 'test-music-server' },
    channel: { id: 'music-channel' },
    member: { voice: { channel: { id: 'voice-channel' } } },
    user: { id: 'test-user', username: 'Test user' },
    options: { getString: () => 'Song' },
  };
  await playCommand.execute(interaction, {}, client);
  assert.equal(deferOptions, undefined, 'the slash response must be visible to everyone');
  assert.equal(publicReply.embeds[0].toJSON().image.url, track.info.artworkUrl);
  assert.equal(publicReply.embeds[0].toJSON().title, 'Now playing');
  assert.deepEqual(publicReply.allowedMentions, { parse: [] });
  assert.equal(queue.length, 1);
});

test('now playing and queue commands publicly show the live track', async t => {
  const deferred = [];
  const edits = [];
  t.mock.method(InteractionHelper, 'safeDefer', async (_interaction, options) => {
    deferred.push(options);
    return true;
  });
  t.mock.method(InteractionHelper, 'safeEditReply', async (_interaction, payload) => {
    edits.push(payload);
    return true;
  });
  const player = { current: track, position: 30_000, queue: [], paused: false };
  const client = { riffy: { players: new Map([['test-music-server-2', player]]) } };
  const interaction = {
    guild: { id: 'test-music-server-2' },
    options: { getInteger: () => 1 },
  };
  await nowplayingCommand.execute(interaction, {}, client);
  await nowCommand.execute(interaction, {}, client);
  await queueCommand.execute(interaction, {}, client);
  assert.deepEqual(deferred, [undefined, undefined, undefined]);
  assert.deepEqual(edits.map(payload => payload.embeds[0].toJSON().title), ['Now playing', 'Now playing', 'Music queue']);
});

test('/music guide also shows the compact embed with its Commands button', async t => {
  const replies = [];
  t.mock.method(InteractionHelper, 'safeDefer', async () => true);
  t.mock.method(InteractionHelper, 'safeEditReply', async (_interaction, payload) => {
    replies.push(payload);
    return true;
  });
  const interaction = { options: { getSubcommand: () => 'guide' } };
  await musicCommand.execute(interaction, {}, {});
  assert.equal(replies.length, 1);
  assert.equal(replies[0].embeds[0].toJSON().title, 'Cloudy music');
  assert.equal(replies[0].components[0].toJSON().components[0].custom_id, 'dedicated_commands:music');
});

test('the player has one row of icon controls; Playlists and Stop share the bottom row', async () => {
  const { buildPlayerButtonRows } = await import('../src/services/music/musicEmbeds.js');
  const rows = buildPlayerButtonRows({ paused: false }, { loop: 'none' }).map(row => row.toJSON().components);
  assert.deepEqual(rows.map(row => row.map(button => button.custom_id)), [
    ['music_pause', 'music_skip', 'music_shuffle', 'music_loop', 'music_queue'],
    ['music_playlists', 'music_stop'],
  ]);
  assert.ok(rows[0].every(button => !button.label), 'icons only, so they stay in one row on a phone');
  const paused = buildPlayerButtonRows({ paused: true }, { loop: 'track' }).map(row => row.toJSON().components);
  assert.equal(paused[0][0].custom_id, 'music_resume');
  assert.equal(paused[0][3].emoji.name, '🔂');
});

test('unchanged now-playing panels do not generate redundant Discord edits', async () => {
  const guildId = 'music-no-redundant-edits';
  const sent = [];
  const edits = [];
  const message = { id: 'one-panel', edit: async payload => { edits.push(payload); } };
  const channel = {
    id: 'music-channel', name: 'music', type: ChannelType.GuildText, isTextBased: () => true,
    messages: { cache: new Collection([['one-panel', message]]), fetch: async () => message },
    send: async payload => { sent.push(payload); return message; },
  };
  const guild = { id: guildId, channels: { cache: new Collection([[channel.id, channel]]) } };
  const player = { current: track, paused: false, playing: true, position: 0, textChannel: channel.id, queue: [] };
  const client = {
    channels: { cache: new Collection([[channel.id, channel]]) },
    guilds: { cache: new Collection([[guildId, guild]]) },
    riffy: { players: new Map([[guildId, player]]) },
  };
  try {
    await refreshPlayerMessage(client, guildId);
    await refreshPlayerMessage(client, guildId);
    assert.equal(sent.length, 1);
    assert.equal(edits.length, 0, 'no edit if progress and buttons have not changed');
    player.paused = true;
    await refreshPlayerMessage(client, guildId);
    assert.equal(edits.length, 1, 'a meaningful change still refreshes the panel');
  } finally {
    deleteGuildMusicData(guildId);
  }
});


test('music embeds preserve original Lavalink artwork even though Riffy drops artworkUrl from info', () => {
  const rawTrack = { info: {
    title: 'Original', author: 'Real artist', length: 120_000, sourceName: 'soundcloud',
    requester: { username: 'Dawg' },
  }, rawData: { info: { artworkUrl: 'https://cdn.example.com/real-cover.jpg' } } };
  assert.equal(getTrackArtwork(rawTrack), 'https://cdn.example.com/real-cover.jpg');
  const panel = buildNowPlayingEmbed(rawTrack, { position: 0, queue: [], paused: false }, {}).toJSON();
  const request = buildMusicRequestEmbed(rawTrack, { playNow: true }).toJSON();
  assert.equal(panel.image.url, 'https://cdn.example.com/real-cover.jpg');
  assert.equal(request.image.url, 'https://cdn.example.com/real-cover.jpg');
  assert.equal(panel.color, 0xFFFFFF);
  assert.equal(request.color, 0xFFFFFF);
  assert.match(panel.thumbnail.url, /cloudy-music-icon\.png/);
  assert.match(request.thumbnail.url, /cloudy-music-icon\.png/);
  assert.ok(panel.fields.every(field => field.inline === false));
  assert.ok(request.fields.every(field => field.inline === false));
});

test('YouTube fallback uses the source identifier; no promise-based thumbnail getter is accessed', () => {
  let getterCalls = 0;
  const info = { identifier: 'dQw4w9WgXcQ', sourceName: 'youtube' };
  Object.defineProperty(info, 'thumbnail', { get() { getterCalls++; return Promise.resolve('wrong'); } });
  assert.equal(getTrackArtwork({ info }), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(getterCalls, 0);
});

test('final Discord output forces white only on music request and player embeds', () => {
  const playing = buildNowPlayingEmbed(track, { position: 5000, queue: [] }, {}).toJSON();
  const request = buildMusicRequestEmbed(track, { playNow: true }).toJSON();
  const warning = { title: 'Other', color: 0x00C49D };
  const result = ensureWhiteMusicEmbeds({ embeds: [
    { ...playing, color: 0x00C49D }, { ...request, color: 0x00C49D }, warning,
  ] });
  assert.deepEqual(result.embeds.map(e => e.color), [0xFFFFFF, 0xFFFFFF, 0x00C49D]);
});
