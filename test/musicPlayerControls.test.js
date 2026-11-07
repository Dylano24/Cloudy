import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MessageFlags } from 'discord.js';
import { buildNowPlayingEmbed, buildPlayerButtonRows, MUSIC_BUTTON_IDS } from '../src/services/music/musicEmbeds.js';
import { getGuildMusicData, deleteGuildMusicData } from '../src/services/music/playerStore.js';
import { musicButtonHandler } from '../src/handlers/musicButtons.js';
import musicButtons from '../src/interactions/buttons/music/music.js';
import addModal from '../src/interactions/modals/musicAdd.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';

const activeTrack = {
  info: {
    title: 'Playing song', author: 'The artist', length: 230000,
    artworkUrl: 'https://example.com/artwork.jpg',
    requester: { username: 'Listener' },
  },
};
const newTrack = {
  info: {
    title: 'New track', author: 'Next artist', length: 180000,
    uri: 'https://music.example.com/track2',
    artworkUrl: 'https://example.com/next-artwork.jpg',
  },
};

function fixture(guildId) {
  const edits = [];
  const queue = [];
  queue.add = track => queue.push(track);
  const player = {
    current: activeTrack,
    voiceChannel: 'voice-1',
    textChannel: 'music-channel',
    paused: false,
    playing: true,
    position: 83000,
    queue,
    loop: 'none',
    setVolume() {},
  };
  const data = getGuildMusicData(guildId);
  data.playerMessageId = 'player-message';
  data.playerChannelId = 'music-channel';
  const message = { id: 'player-message', edit: async payload => edits.push(payload) };
  const channel = {
    id: 'music-channel',
    messages: { cache: new Collection([[message.id, message]]) },
  };
  const client = {
    riffy: {
      players: new Map([[guildId, player]]),
      resolve: async () => ({ loadType: 'track', tracks: [{ info: { ...newTrack.info } }] }),
    },
    channels: { cache: new Collection([[channel.id, channel]]) },
    guilds: { cache: new Collection() },
  };
  const member = { voice: { channel: { id: 'voice-1' } } };
  const user = { id: 'music-member', username: 'Listener' };
  return { data, player, client, member, user, edits, queue, channel };
}

test('the Music player shows real track artwork, elapsed time and 20-part live progress', () => {
  const card = buildNowPlayingEmbed(activeTrack, {
    position: 83000, paused: false, queue: [], 
  }, { volume: 75, loop: 'none' }).toJSON();
  assert.equal(card.image.url, activeTrack.info.artworkUrl);
  assert.equal(card.title, 'Now playing');
  const progress = card.fields.find(field => field.name === 'Progress');
  assert.ok(progress.value.includes('1:23 / 3:50'));
  assert.equal(progress.value.split('\n')[0].length, 20);
  assert.equal(progress.inline, false);
  const start = buildNowPlayingEmbed(activeTrack, {
    position: 0, paused: false, queue: [],
  }, {}).toJSON();
  assert.match(start.fields.find(field => field.name === 'Progress').value, /0:00 \/ 3:50/);
});

test('buttons match preview: Pause / Skip / Add / Queue / Stop and optional controls below', () => {
  const playing = buildPlayerButtonRows({ paused: false }, { loop: 'none', shuffle: false });
  assert.equal(playing.length, 2);
  assert.deepEqual(playing[0].toJSON().components.map(button => button.custom_id), [
    MUSIC_BUTTON_IDS.PAUSE, MUSIC_BUTTON_IDS.SKIP, MUSIC_BUTTON_IDS.ADD,
    MUSIC_BUTTON_IDS.QUEUE, MUSIC_BUTTON_IDS.STOP,
  ]);
  assert.deepEqual(playing[1].toJSON().components.map(button => button.custom_id), [
    MUSIC_BUTTON_IDS.SHUFFLE, MUSIC_BUTTON_IDS.LOOP,
    MUSIC_BUTTON_IDS.VOL_DOWN, MUSIC_BUTTON_IDS.VOL_UP,
  ]);
  const paused = buildPlayerButtonRows({ paused: true }, { loop: 'track' });
  assert.equal(paused[0].toJSON().components[0].custom_id, MUSIC_BUTTON_IDS.RESUME);
  assert.equal(paused[0].toJSON().components[0].label, 'Resume');
  assert.equal(paused[0].toJSON().components.filter(b => b.label === 'Pause').length, 0);
  assert.ok(musicButtons.some(button => button.name === MUSIC_BUTTON_IDS.ADD),
    'new Add button must be registered alongside the existing music buttons');
  assert.equal(addModal.name, MUSIC_BUTTON_IDS.ADD_MODAL);
});

test('Add opens a song-name modal without altering playback', async t => {
  const guildId = 'music-add-button-success';
  const f = fixture(guildId);
  t.after(() => deleteGuildMusicData(guildId));
  let shown;
  const interaction = {
    guild: { id: guildId },
    member: f.member,
    user: f.user,
    message: { id: f.data.playerMessageId },
    customId: MUSIC_BUTTON_IDS.ADD,
    showModal: async modal => { shown = modal.toJSON(); },
  };
  await musicButtonHandler.execute(interaction, f.client);
  assert.equal(shown.title, 'Add to queue');
  assert.equal(shown.custom_id, `${MUSIC_BUTTON_IDS.ADD_MODAL}:player-message`);
  assert.equal(shown.components[0].components[0].custom_id, 'music_add_query');
  assert.equal(f.queue.length, 0);
  assert.equal(f.edits.length, 0);
});

test('Add cannot be opened from an outdated player or different voice channel', async t => {
  const guildId = 'music-add-button-denials';
  const f = fixture(guildId);
  t.after(() => deleteGuildMusicData(guildId));
  let opens = 0;
  const replies = [];
  const interaction = {
    guild: { id: guildId }, member: f.member, user: f.user,
    id: 'music-add-button-denial', createdTimestamp: Date.now(),
    message: { id: 'old-message' },
    customId: MUSIC_BUTTON_IDS.ADD,
    showModal: async () => { opens++; },
    reply: async payload => { replies.push(payload); },
  };
  await musicButtonHandler.execute(interaction, f.client);
  assert.equal(opens, 0);
  assert.equal(replies.length, 1);
  interaction.message.id = 'player-message';
  interaction.member = { voice: { channel: { id: 'another-voice' } } };
  await musicButtonHandler.execute(interaction, f.client);
  assert.equal(opens, 0);
  assert.equal(replies.length, 2);
});

test('Add modal submits a song to the existing queue and refreshes one public player', async t => {
  const guildId = 'music-add-modal-success';
  const f = fixture(guildId);
  t.after(() => deleteGuildMusicData(guildId));
  const responses = [];
  const deferred = [];
  t.mock.method(InteractionHelper, 'safeDefer', async (_interaction, opts) => {
    deferred.push(opts);
    return true;
  });
  t.mock.method(InteractionHelper, 'safeEditReply', async (_interaction, payload) => {
    responses.push(payload);
    return true;
  });
  const interaction = {
    guildId, guild: { id: guildId }, channel: { id: 'music-channel' },
    member: f.member, user: f.user, customId: `${MUSIC_BUTTON_IDS.ADD_MODAL}:player-message`,
    fields: { getTextInputValue: key => key === 'music_add_query' ? 'New track' : null },
  };
  await addModal.execute(interaction, f.client, ['player-message']);
  assert.deepEqual(deferred, [{ flags: MessageFlags.Ephemeral }]);
  assert.equal(f.queue.length, 1);
  assert.equal(f.queue[0].info.title, newTrack.info.title);
  assert.equal(f.queue[0].info.requester, f.user);
  assert.equal(f.edits.length, 1);
  assert.equal(f.edits[0].embeds[0].toJSON().image.url, activeTrack.info.artworkUrl);
  assert.equal(f.edits[0].embeds[0].toJSON().fields.find(field => field.name === 'Queue').value, '1 track');
  assert.equal(f.data.playerMessageId, 'player-message');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].embeds[0].toJSON().title, 'Added to queue');
  assert.deepEqual(responses[0].allowedMentions, { parse: [] });
});

test('a stale Add modal is denied before enqueueing or acknowledging a private success', async t => {
  const guildId = 'music-add-modal-stale';
  const f = fixture(guildId);
  t.after(() => deleteGuildMusicData(guildId));
  let defers = 0, replies = 0;
  t.mock.method(InteractionHelper, 'safeDefer', async () => { defers++; return true; });
  const interaction = {
    guildId, guild: { id: guildId }, channel: { id: 'music-channel' },
    id: 'stale-modal-id', createdTimestamp: Date.now(),
    member: f.member, user: f.user, customId: `${MUSIC_BUTTON_IDS.ADD_MODAL}:old-player`,
    fields: { getTextInputValue: () => 'New track' },
    reply: async () => { replies++; },
  };
  await addModal.execute(interaction, f.client, ['old-player']);
  assert.equal(defers, 0);
  assert.equal(f.queue.length, 0);
  assert.equal(f.edits.length, 0);
  assert.equal(replies, 1);
});
