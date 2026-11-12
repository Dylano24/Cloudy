import test from 'node:test';
import { cardButtons, cardCover, cardHeading, cardTexts } from './helpers/playerCard.js';
import assert from 'node:assert/strict';
import { ChannelType, Collection, MessageFlags } from 'discord.js';
import { PLAYER_FOOTER_PICTURE_URL } from '../src/services/music/musicEmbeds.js';
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

test('music guide keeps Cloudy branding and the commands explain the player buttons by their symbols', async () => {
  const { PLAYER_BUTTON_SYMBOLS: symbols } = await import('../src/services/music/musicEmbeds.js');
  const guide = buildMusicGuideEmbed().toJSON();
  assert.equal(guide.title, 'Cloudy music');
  assert.match(guide.description, /Click the button below/);
  assert.ok(!guide.description.includes('/now playing'), 'the public panel must remain short');
  const commands = buildMusicCommandsEmbed().toJSON();
  assert.equal(commands.title, 'Music commands');
  // The buttons of the player in their order, one short line each with one symbol, so the lines stay neatly under each other.
  const all = commands.description.split('\n');
  const lines = all.slice(all.indexOf('**Player buttons**') + 1);
  assert.deepEqual(lines.map(line => line.split(' ')[0]), [symbols.shuffle, symbols.previous, symbols.pause, symbols.next, symbols.repeat, symbols.queue, symbols.add, symbols.remove, symbols.stop]);
  for (const line of lines) {
    assert.ok(line.length <= 26, `Explanation must stay short: ${line}`);
    assert.ok(!line.includes('**') && !line.includes(' — '), `No names or dashes, just the symbol and a few words: ${line}`);
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
    send: async payload => { panels.push(payload); return { id: 'live-player-1' }; },
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
    member: { voice: { channel: { id: 'voice-channel' } }, displayName: 'Dylano' },
    user: { id: 'test-user', username: 'Test user' },
    options: { getString: () => 'Song' },
    deleteReply: async () => { deletedReply = true; },
  };
  await playCommand.execute(interaction, {}, client);
  assert.equal(deferOptions.flags, MessageFlags.Ephemeral, 'the slash acknowledgement is not public');
  assert.equal(publicReply, null, 'no duplicate /play announcement is posted');
  assert.equal(deletedReply, true, 'the temporary acknowledgement is deleted');
  assert.equal(panels.length, 1, 'exactly one public player panel is posted');
  // One card like Spotify's: cover on top, title and artist, bar, duration and the buttons inside it.
  assert.equal(panels[0].flags, MessageFlags.IsComponentsV2);
  assert.equal(cardCover(panels[0]), track.info.artworkUrl);
  assert.equal(cardHeading(panels[0]), null, 'no "Now playing" line');
  assert.ok(cardTexts(panels[0]).includes('### Song\nArtist'));
  // Owner's choice: "Requested by" with the display name where the time was, above the
  // buttons, and the song's length on the right with the blue dot (no running timer).
  const parts = panels[0].components[0].toJSON().components;
  const section = parts.find(part => part.type === 9);
  assert.equal(section.components[0].content, '-# <:W87205667glowingdotwhite:1543291335036108830> Requested by Dylano', 'the display name, not the username');
  assert.equal(section.accessory.custom_id, 'music_time');
  assert.equal(section.accessory.label, '3:00');
  assert.equal(section.accessory.emoji.name, '🔵', 'the blue dot (until Cloudy\'s own is uploaded)');
  assert.equal(parts.indexOf(section), parts.findIndex(part => part.type === 1) - 1, 'right above the buttons');
  assert.ok(!cardTexts(panels[0]).some(text => / \/ /.test(text)), 'no running timer');
  const pictures = parts.filter(part => part.type === 12);
  assert.equal(pictures.length, 2, 'the cover and the footer');
  assert.equal(parts.at(-1).type, 12, 'the card ends with the footer picture');
  assert.equal(parts.at(-1).items[0].media.url, PLAYER_FOOTER_PICTURE_URL);
  assert.equal(parts.at(-1).items[0].description, undefined, 'no ALT label');
  assert.equal(parts.at(-2).type, 1, 'right under the buttons');
  assert.deepEqual(cardButtons(panels[0]), ['music_time', 'music_shuffle', 'music_previous', 'music_pause', 'music_skip', 'music_loop', 'music_queue', 'music_playlists', 'music_remove', 'music_stop']);
  assert.equal(panels[0].components.length, 1, 'the buttons are inside the card');
  assert.deepEqual(panels[0].allowedMentions, { parse: [] });
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

test('the player buttons are the original white icons without text, with + and - below', async () => {
  const { buildPlayerButtonRows } = await import('../src/services/music/musicEmbeds.js');
  const rows = buildPlayerButtonRows({ paused: false }, { loop: 'none' }).map(row => row.toJSON().components);
  assert.deepEqual(rows.map(row => row.map(button => button.custom_id)), [
    ['music_shuffle', 'music_previous', 'music_pause', 'music_skip', 'music_loop'],
    ['music_queue', 'music_playlists', 'music_remove', 'music_stop'],
  ]);
  // Owner's choice: back to the first buttons, but without text. Until Cloudy's own
  // icons are uploaded the standard emoji show.
  assert.ok(rows.flat().every(button => button.emoji && !button.label), 'an icon only, no text');
  assert.deepEqual(rows.flat().map(button => button.emoji.name), ['🔀', '⏮️', '⏸️', '⏭️', '🔁', '📋', '➕', '➖', '⏹️']);
  assert.deepEqual(rows.flat().map(button => button.style), [2, 2, 2, 2, 2, 2, 2, 2, 2], 'every button grey');
  const paused = buildPlayerButtonRows({ paused: true }, { loop: 'track', shuffle: true }).map(row => row.toJSON().components);
  assert.equal(paused[0][2].custom_id, 'music_resume');
  assert.equal(paused[0][2].emoji.name, '▶️');
  assert.equal(paused[0][4].emoji.name, '🔂', 'repeat this song');
});

test('the + and - icons are drawn in the white style of the other player icons', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const name of ['mc_plus', 'mc_minus']) {
    const image = await readFile(new URL(`../assets/music-icons/${name}.png`, import.meta.url));
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', name + ' is a PNG');
    assert.equal(image.readUInt32BE(16), 128);
    assert.equal(image.readUInt32BE(20), 128);
  }
});

test('the approved silver music artwork contains all nine control icons plus Play and Repeat one', async () => {
  const { MUSIC_CONTROL_ART_KEYS, musicControlSvg } = await import('../src/services/music/musicControlArtwork.js');
  assert.deepEqual(MUSIC_CONTROL_ART_KEYS, [
    'shuffle', 'previous', 'pause', 'next', 'repeat', 'queue', 'add', 'remove', 'stop', 'play', 'repeat_one',
  ]);
  for (const key of MUSIC_CONTROL_ART_KEYS) {
    const art = musicControlSvg(key);
    assert.match(art, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="128" height="128" viewBox="-42 -42 84 84">/);
    assert.match(art, /url\(#steel\)/, key + ' should use the shared silver-white gradient');
    assert.ok(!/<animate|<image|data:|<script/i.test(art), key + ' must be a static vector with no remote dependencies');
  }
  assert.equal(musicControlSvg('not-a-music-icon'), null);
  const { musicControlPng } = await import('../src/services/music/musicControlPngData.js');
  for (const key of MUSIC_CONTROL_ART_KEYS) {
    const image = musicControlPng(key);
    assert.ok(Buffer.isBuffer(image), key + ' is ready for Discord application emoji upload');
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', key + ' has a PNG header');
    // Shuffle v2 is drawn at 128 px (sharper on a phone); the others at 64 px.
    const size = key === 'shuffle' ? 128 : 64;
    assert.equal(image.readUInt32BE(16), size);
    assert.equal(image.readUInt32BE(20), size);
    assert.ok(image.length < 256 * 1024, key + ' stays below Discord\'s emoji size limit');
  }
  assert.equal(musicControlPng('not-a-music-icon'), null);
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

test('the footer picture is the 14 footer pieces side by side, and the player card is still recognised by it', async () => {
  const { readFile } = await import('node:fs/promises');
  const { buildPlayerCard, isPlayerCardMessage, PLAYER_FOOTER_PICTURE_URL: url } = await import('../src/services/music/musicEmbeds.js');
  const png = await readFile(new URL('../assets/music-footer-line.png', import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 2146, 'the 14 pieces (1792 px) fill 83.5% of the width, as the emoji line did');
  assert.equal(png.readUInt32BE(20), 128);
  assert.equal(png[25], 6, 'transparent background');
  assert.match(url, /^https:\/\/cdn\.jsdelivr\.net\/gh\/Dylano24\/Cloudy@[0-9a-f]{40}\/assets\/music-footer-line\.png$/, 'a fixed commit, so the link never changes');
  const song = { info: { title: 'Song', author: 'Artist', length: 180_000, requester: { username: 'Test user' } } };
  const live = buildPlayerCard(song, { current: song, paused: false, position: 5_000, queue: [] }, {});
  const record = buildPlayerCard(song, { current: song, paused: false, position: 5_000, queue: [] }, {}, { ended: 'Played' });
  const asMessage = payload => ({ components: payload.components.map(component => component.toJSON()) });
  assert.equal(isPlayerCardMessage(asMessage(live)), true, 'Stop and a new session still clean up the live card');
  assert.equal(isPlayerCardMessage(asMessage(record)), true, 'and its records');
  assert.ok(cardTexts(record).some(text => text.includes('Requested by Test user')), 'a record keeps Requested by');
  assert.equal(JSON.stringify(live).split(url).length - 1, 1, 'one footer picture on the live card');
});

test('the redrawn shuffle icon is uploaded as a new emoji (v2); the other icons keep theirs', async t => {
  // Other emojis would be downloaded from Discord; the test stays offline.
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  const { ensureFeedEmojis, feedEmojiReady } = await import('../src/services/feedEmojiService.js');
  const { musicControlPng } = await import('../src/services/music/musicControlPngData.js');
  const existing = new Collection([['old-shuffle', { id: '1569000000000000001', name: 'cmusic_shuffle_v1' }],
    ['old-play', { id: '1569000000000000002', name: 'cmusic_play_v1' }]]);
  const created = [];
  const client = { emojis: { cache: new Collection() }, application: { emojis: {
    fetch: async () => existing,
    create: async ({ attachment, name }) => { created.push({ name, attachment }); return { id: String(1569000000000000100n + BigInt(created.length)), name }; },
  } } };
  await ensureFeedEmojis(client);
  const shuffle = created.find(item => item.name === 'cmusic_shuffle_v2');
  assert.ok(shuffle, 'the new shuffle icon is uploaded');
  assert.ok(shuffle.attachment.equals(musicControlPng('shuffle')));
  assert.ok(!created.some(item => item.name === 'cmusic_play_v1'), 'an icon that did not change is not uploaded again');
  assert.equal(feedEmojiReady('mc_button_shuffle'), true);
});
