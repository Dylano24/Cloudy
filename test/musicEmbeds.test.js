import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import { buildNowPlayingEmbed, buildQueueEmbed } from '../src/services/music/musicEmbeds.js';
import { refreshPlayerMessage } from '../src/services/music/playerHandler.js';
import { deleteGuildMusicData, getGuildMusicData } from '../src/services/music/playerStore.js';

const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const track = { info: { title: 'Song', author: 'Artist', length: 180_000, artworkUrl: 'https://i.ytimg.com/vi/x/hq.jpg', requester: { username: 'Dawg' } } };

test('now playing: sentence-case title, Cloudy logo and footer, cover art as image, status as a field', () => {
  const embed = buildNowPlayingEmbed(track, { position: 60_000, paused: true, queue: [track] }, { volume: 80, loop: 'none' }).toJSON();
  assert.equal(embed.title, 'Now playing');
  assert.equal(embed.description, '**Song**');
  assert.match(embed.thumbnail.url, /cloudy-c-logo/);
  assert.equal(embed.image.url, 'https://i.ytimg.com/vi/x/hq.jpg');
  assert.equal(embed.footer.text, FOOTER);
  assert.deepEqual(embed.fields.map(field => [field.name, field.value]), [
    ['Artist', 'Artist'], ['Requested by', 'Dawg'], ['Progress', '1:00 / 3:00'], ['Status', 'Paused'],
    ['Volume', '80%'], ['Loop', 'Off'], ['Queue', '1 track'],
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
  deleteGuildMusicData(guildId);
});
