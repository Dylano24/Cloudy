import test from 'node:test';
import { cardButtons, cardCover, cardHeading, cardTexts } from './helpers/playerCard.js';
import assert from 'node:assert/strict';
import { ChannelType, Collection, MessageFlags } from 'discord.js';
import { buildNowPlayingEmbed, buildQueueEmbed, buildMusicGuideEmbed, buildMusicCommandsEmbed, buildMusicRequestEmbed, formatMusicProgress } from '../src/services/music/musicEmbeds.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';
import playCommand from '../src/commands/Music/play.js';
import nowCommand from '../src/commands/Music/now.js';
import nowplayingCommand from '../src/commands/Music/nowplaying.js';
import queueCommand from '../src/commands/Music/queue.js';
import musicCommand from '../src/commands/Music/music.js';
import { refreshPlayerMessage, markTrackStarted } from '../src/services/music/playerHandler.js';
import { deleteGuildMusicData, getGuildMusicData } from '../src/services/music/playerStore.js';

const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const track = { info: { title: 'Song', author: 'Artist', length: 180_000, artworkUrl: 'https://i.ytimg.com/vi/x/hq.jpg', requester: { username: 'Dawg' } } };

test('now playing: sentence-case title, Cloudy logo and footer, cover art as image, status as a field', () => {
  const embed = buildNowPlayingEmbed(track, { position: 60_000, paused: true, queue: [track] }, { volume: 80, loop: 'none' }).toJSON();
  assert.equal(embed.title, 'Now playing');
  // The progress bar sits in the text on its own line, ten pieces with a knob where the song is (like Spotify),
  // and there is no "position / length" text (plain blocks until the pieces are uploaded).
  assert.equal(embed.description, '**Song**\n\n▰▰▰▰●▱▱▱▱▱▱▱▱▱');
  assert.equal(buildNowPlayingEmbed({ info: { ...track.info, length: 0 } }, { position: 0, queue: [] }, {}).toJSON().description, '**Song**');
  assert.match(embed.thumbnail.url, /cloudy-c-logo/);
  assert.equal(embed.image.url, 'https://i.ytimg.com/vi/x/hq.jpg');
  assert.equal(embed.footer.text, FOOTER);
  assert.deepEqual(embed.fields.map(field => [field.name, field.value]), [
    ['Artist', 'Artist'], ['Requested by', 'Dawg'], ['Duration', '3:00'], ['Status', 'Paused'], ['Loop', 'Off'], ['Queue', '1 track'],
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
  markTrackStarted(player); // Lavalink reported the song started
  const client = {
    channels: { cache: new Collection([[music.id, music], [general.id, general]]) },
    guilds: { cache: new Collection([[guildId, { id: guildId, channels: { cache: new Collection([[music.id, music], [general.id, general]]) } }]]) },
    riffy: { players: new Map([[guildId, player]]) },
  };
  const data = getGuildMusicData(guildId);
  data.playerChannelId = general.id;
  await refreshPlayerMessage(client, guildId);
  assert.deepEqual(sent.map(entry => entry.channel), ['🎧│music', '🎧│music'], 'the card and its controls, both in #music');
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
  assert.deepEqual(lines.map(line => line.split(' ')[0]), ['🔀', '⏮️', '⏸️', '⏭️', '🔁', '📋', '🎵', '⏹️']);
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

test('/play shows only the persistent player and cleans up its private acknowledgement', async t => {
  let deferOptions = 'not-called';
  let publicReply = null;
  let deletedReply = false;
  const panels = [];
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
    // Like Lavalink: the song starts and the node reports it (TrackStartEvent).
    setVolume() {}, play() { this.playing = true; this.current = queue.shift(); markTrackStarted(this); },
  };
  const musicChannel = {
    id: 'music-channel', name: '🎧│music', type: ChannelType.GuildText,
    isTextBased: () => true,
    messages: { cache: new Collection() },
    send: async payload => { panels.push(payload); return { id: `live-player-${panels.length}` }; },
  };
  const client = {
    channels: { cache: new Collection([[musicChannel.id, musicChannel]]) },
    guilds: { cache: new Collection([['test-music-server', {
      id: 'test-music-server', channels: { cache: new Collection([[musicChannel.id, musicChannel]]) },
    }]]) },
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
    deleteReply: async () => { deletedReply = true; },
  };
  await playCommand.execute(interaction, {}, client);
  assert.equal(deferOptions.flags, MessageFlags.Ephemeral, 'the slash acknowledgement is not public');
  assert.equal(publicReply, null, 'no duplicate /play announcement is posted');
  assert.equal(deletedReply, true, 'the temporary acknowledgement is deleted');
  assert.equal(panels.length, 2, 'one public player: the card and, under it, its controls');
  // The card (redrawn every second): cover on top, title and artist, timer and bar. No buttons, so Discord
  // never loads their icons again on a tick.
  assert.equal(panels[0].flags, MessageFlags.IsComponentsV2);
  assert.equal(cardCover(panels[0]), track.info.artworkUrl);
  assert.equal(cardHeading(panels[0]), null, 'no "Now playing" line');
  assert.ok(cardTexts(panels[0]).includes('### Song\nArtist'));
  assert.match(cardTexts(panels[0])[1], /^-# 0:00 \/ 3:00\n/, 'the timer on the left right above the bar');
  const parts = panels[0].components[0].toJSON().components;
  assert.equal(parts.filter(part => part.type === 12).length, 1, 'only the cover is a picture');
  assert.equal(parts.at(-1).type, 10, 'the card ends with the timer and the bar');
  assert.deepEqual(cardButtons(panels[0]), [], 'no buttons on the card');
  assert.deepEqual(panels[0].allowedMentions, { parse: [] });
  // The controls (redrawn only when something on them changes): the buttons, Requested by after the white dot and
  // the footer on the line under it (14 emoji pieces once uploaded, as wide as the bar; until then the footer text).
  assert.equal(panels[1].flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(cardButtons(panels[1]), ['music_shuffle', 'music_previous', 'music_pause', 'music_skip', 'music_loop', 'music_queue', 'music_playlists', 'music_stop']);
  assert.equal(cardTexts(panels[1]).at(-1), '-# <:W87205667glowingdotwhite:1543291335036108830> Requested by Test user\n-# **© Cloudy Inc. • Quality. Innovation. Performance.**');
  assert.equal(panels[1].components.length, 1);
  assert.equal(panels[1].components[0].toJSON().components.at(-1).type, 10, 'the controls end with the footer text');
  assert.deepEqual(panels[1].allowedMentions, { parse: [] });
  assert.equal(queue.length, 0);
  deleteGuildMusicData('test-music-server');
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

test('the player controls are in Spotify\'s order with Play/Pause in the middle; Queue, Add and Stop share the bottom row', async () => {
  const { buildPlayerButtonRows } = await import('../src/services/music/musicEmbeds.js');
  const rows = buildPlayerButtonRows({ paused: false }, { loop: 'none' }).map(row => row.toJSON().components);
  assert.deepEqual(rows.map(row => row.map(button => button.custom_id)), [
    ['music_shuffle', 'music_previous', 'music_pause', 'music_skip', 'music_loop'],
    ['music_queue', 'music_playlists', 'music_stop'],
  ]);
  assert.ok(rows[0].every(button => !button.label), 'icons only, so they stay in one row on a phone');
  assert.deepEqual(rows[0].map(button => button.emoji.name), ['🔀', '⏮️', '⏸️', '⏭️', '🔁'], 'standard emoji until the icons are uploaded');
  assert.deepEqual(rows.flat().map(button => button.style), [2, 2, 2, 2, 2, 2, 2, 2], 'every button grey, also Play/Pause and Stop');
  assert.deepEqual(rows[1].map(button => button.label || button.emoji.name), ['📋', 'Add', 'Stop'], 'the saved playlists button says Add');
  assert.equal(rows[1][1].emoji.name, '🎵', 'with the music emoji');
  const paused = buildPlayerButtonRows({ paused: true }, { loop: 'track' }).map(row => row.toJSON().components);
  assert.equal(paused[0][2].custom_id, 'music_resume');
  assert.equal(paused[0][2].emoji.name, '▶️');
  assert.equal(paused[0][4].emoji.name, '🔂');
});

test('the card shows the sharpest copy of the cover, however the song was added', async () => {
  const { bestArtworkUrl, sharperArtworkCandidates } = await import('../src/services/music/musicArtwork.js');
  const asked = [];
  const fetchImpl = async url => { asked.push(url); return { ok: url.endsWith('/hq720.jpg'), headers: new Map([['content-type', 'image/jpeg']]) }; };
  assert.equal(await bestArtworkUrl('https://i.ytimg.com/vi/abcDEF12345/mqdefault.jpg', { fetchImpl }), 'https://i.ytimg.com/vi/abcDEF12345/hq720.jpg');
  assert.equal(await bestArtworkUrl('https://i.ytimg.com/vi/abcDEF12345/mqdefault.jpg', { fetchImpl }), 'https://i.ytimg.com/vi/abcDEF12345/hq720.jpg', 'checked once');
  assert.equal(asked.length, 2, 'both large copies checked at once, the first time only');
  const none = async () => ({ ok: false });
  assert.equal(await bestArtworkUrl('https://i.ytimg.com/vi/zzzzzz99999/mqdefault.jpg', { fetchImpl: none }), 'https://i.ytimg.com/vi/zzzzzz99999/mqdefault.jpg', 'the original when nothing sharper exists');
  assert.deepEqual(sharperArtworkCandidates('https://lh3.googleusercontent.com/abc_DEF-1=w120-h120-l90-rj'), ['https://lh3.googleusercontent.com/abc_DEF-1=w1200-h1200-l90-rj'], 'YouTube Music');
  assert.deepEqual(sharperArtworkCandidates('https://i.scdn.co/image/ab67616d00001e02ff00aa'), ['https://i.scdn.co/image/ab67616d0000b273ff00aa'], 'Spotify 640 px');
  assert.deepEqual(sharperArtworkCandidates('https://i1.sndcdn.com/artworks-abc123-xyz-large.jpg'), ['https://i1.sndcdn.com/artworks-abc123-xyz-t500x500.jpg'], 'SoundCloud');
  assert.deepEqual(sharperArtworkCandidates('https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/source/100x100bb.jpg'), ['https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/source/1000x1000bb.jpg'], 'Apple Music');
  assert.deepEqual(sharperArtworkCandidates('https://e-cdns-images.dzcdn.net/images/cover/0a1b/250x250-000000-80-0-0.jpg'), ['https://e-cdns-images.dzcdn.net/images/cover/0a1b/1000x1000-000000-80-0-0.jpg'], 'Deezer');
  assert.deepEqual(sharperArtworkCandidates('https://i.scdn.co/image/ab67616d0000b273aa'), [], 'already the large copy');
  assert.deepEqual(sharperArtworkCandidates('https://example.com/cover.jpg'), [], 'other hosts are never asked');
});

test('a button gets Cloudy\'s uploaded icon as an emoji object, else the standard emoji', async () => {
  const { emojiComponentFromMarkup } = await import('../src/services/feedEmojiService.js');
  assert.deepEqual(emojiComponentFromMarkup('<:cloudy_mc_play:1234567890>', '▶️'), { id: '1234567890', name: 'cloudy_mc_play', animated: false });
  assert.deepEqual(emojiComponentFromMarkup('<a:spin:42>', '▶️'), { id: '42', name: 'spin', animated: true });
  assert.equal(emojiComponentFromMarkup(undefined, '▶️'), '▶️');
  assert.equal(emojiComponentFromMarkup('▶️', '▶️'), '▶️');
});
