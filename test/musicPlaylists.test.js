import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  addPlaylist, listPlaylists, removePlaylist, openPlaylistPanel, openRemovePlaylistPanel, handleMusicPlaylistControls,
} from '../src/services/music/musicPlaylists.js';
import { playQuery } from '../src/services/music/musicActions.js';
import { getGuildMusicData, deleteGuildMusicData } from '../src/services/music/playerStore.js';

const track = n => ({ info: { title: 'Song ' + n, author: 'Artist', uri: 'https://example.com/' + n, length: 1000 } });
const roadTrip = () => ({ loadType: 'playlist', playlistInfo: { name: 'Road trip' }, tracks: [track(1), track(2)] });
function fakeBot(resolve) {
  const data = new Map();
  const queue = Object.assign([], { add(item) { this.push(item); }, clear() { this.length = 0; } });
  const player = {
    queue, current: null, playing: false, paused: false, loop: 'none', stops: 0,
    setVolume() {}, setLoop(mode) { this.loop = mode; }, pause(value) { this.paused = value; },
    play() { this.current = queue.shift(); this.playing = true; return this; },
    stop() { this.stops += 1; },
    destroy() { this.destroyed = true; client.riffy.players.delete(this.guildId); },
  };
  const client = {
    channels: { cache: new Map() },
    db: {
      get: async key => structuredClone(data.get(key) ?? null),
      set: async (key, value) => { data.set(key, structuredClone(value)); return true; },
      delete: async key => data.delete(key),
    },
    riffy: {
      players: new Map(),
      createConnection: options => {
        Object.assign(player, { guildId: options.guildId, voiceChannel: options.voiceChannel });
        client.riffy.players.set(options.guildId, player);
        return player;
      },
      resolve: resolve || (async () => roadTrip()),
    },
  };
  return { client, data, player };
}
// A playlist link resolves to Road trip, anything else to one song.
const byQuery = async ({ query }) => (/playlist|road/.test(query) ? roadTrip() : { loadType: 'search', tracks: [track(9)] });
function fakeUi(guildId) {
  const log = { edits: [], followUps: [], modals: [], deleted: [], removed: [], deferredReplies: [], deferredUpdates: 0, root: null };
  const make = (customId, kind, extra = {}) => ({
    customId, guildId, user: { id: 'owner', username: 'Mila' },
    guild: { id: guildId }, channel: { id: 'text' }, member: { voice: { channel: { id: 'voice' } } },
    memberPermissions: { has: permission => permission === PermissionFlagsBits.ManageGuild },
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'string',
    isAnySelectMenu: () => kind === 'string',
    isModalSubmit: () => kind === 'modal',
    deferred: false,
    replied: false,
    async deferUpdate() { this.deferred = true; log.deferredUpdates += 1; },
    async deferReply(options) { this.deferred = true; log.deferredReplies.push(options); },
    editReply: async payload => { log.edits.push(payload); },
    deleteReply: async (message = '@original') => { (message === '@original' ? log.deleted : log.removed).push(message.id || message); },
    showModal: async modal => { log.modals.push(modal.toJSON()); },
    followUp: async payload => { log.followUps.push(payload); return { id: 'notice' + log.followUps.length }; },
    ...extra,
  });
  return { log, make };
}
// The player's Add button opens the form at once.
async function open(client, ui, extra = {}) {
  await openPlaylistPanel(ui.make('music_playlists', 'button', { reply: async payload => { ui.log.root = payload; }, ...extra }), client);
  return ui.log.modals.at(-1);
}

async function openRemove(client, ui, extra = {}) {
  await openRemovePlaylistPanel(ui.make('music_remove', 'button', extra), client);
  return ui.log.modals.at(-1);
}
function submit(client, ui, form, { add = '', start = [], remove = [], jam = [] } = {}, extra = {}) {
  const fields = {
    getTextInputValue: id => (id === 'add' ? add : ''),
    getStringSelectValues: id => ({ start, remove, jam })[id] || [],
  };
  return handleMusicPlaylistControls(ui.make(form.custom_id, 'modal', { fields, ...extra }), client);
}
const labels = form => form.components.filter(item => item.type === 18);
const notice = ui => ui.log.edits.at(-1).embeds[0].toJSON();
const DOT = '<a:glowing_dot_green:1567760480439771286>';
const WHITE = '<:W87205667glowingdotwhite:1543291335036108830>';
const BLUE = '🔵'; // Cloudy's blue dot before it is uploaded
const MAX_NOTE = '-# Max 10 songs or playlists in the queue';
const settle = () => new Promise(resolve => setImmediate(resolve));

test('the list lives only for the session, with limits, and only the owner or a moderator removes one', async () => {
  const { client, data } = fakeBot();
  data.set('guild:g-store:music-playlists', { items: [{ id: 'old', url: 'https://x/old', name: 'Old', count: 1 }] });
  const a = await addPlaylist(client, 'g-store', { url: 'https://open.spotify.com/playlist/a', name: 'A', count: 3, ownerId: 'u1', ownerName: 'Mila' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(data.has('guild:g-store:music-playlists'), false, 'a list stored before is deleted; nothing is saved');
  assert.deepEqual((await listPlaylists(client, 'g-store')).map(item => item.name), ['A']);
  await assert.rejects(addPlaylist(client, 'g-store', { url: 'https://open.spotify.com/playlist/a', name: 'Again', count: 1, ownerId: 'u2', ownerName: 'Sam' }), error => /already in your list/.test(error.userMessage));
  for (let n = 1; n < 10; n += 1) await addPlaylist(client, 'g-store', { url: 'https://x/' + n, name: 'P' + n, count: 1, ownerId: 'u1', ownerName: 'Mila' });
  await assert.rejects(addPlaylist(client, 'g-store', { url: 'https://x/extra', name: 'Extra', count: 1, ownerId: 'u1', ownerName: 'Mila' }), error => /up to 10/.test(error.userMessage));
  assert.equal((await listPlaylists(client, 'g-store')).length, 10);
  assert.deepEqual(await removePlaylist(client, 'g-store', a.id, { userId: 'u2' }), { removed: false, reason: 'forbidden' });
  assert.equal((await removePlaylist(client, 'g-store', a.id, { userId: 'u2', canManage: true })).removed, true);
  assert.deepEqual(await removePlaylist(client, 'g-store', a.id, { userId: 'u1' }), { removed: false, reason: 'missing' });
  deleteGuildMusicData('g-store');
});

test('the - button opens Remove only and removes the active playlist using the existing flow', async () => {
  const { client, player } = fakeBot(byQuery);
  const ui = fakeUi('g-minus-active');
  await playQuery(client, ui.make('play', 'command'), 'https://open.spotify.com/playlist/road');
  await playQuery(client, ui.make('play', 'command'), 'another song');
  const form = await openRemove(client, ui);
  assert.equal(form.title, 'Remove from your list');
  assert.deepEqual(labels(form).map(label => label.label), ['Remove']);
  const removeOptions = labels(form)[0].component.options;
  assert.equal(removeOptions[0].value, 'active', 'the playing playlist is offered for removal');
  assert.equal(removeOptions[0].label, 'Road trip');
  assert.ok(removeOptions.some(option => option.label === 'Song 9'), 'the queue remains selectable');
  assert.equal(ui.log.followUps.length, 0, 'the - click does not post a message');
  await submit(client, ui, form, { remove: ['active'] });
  assert.equal(notice(ui).description, '**Road trip** was removed.');
  assert.equal(player.stops, 1);
  assert.deepEqual(player.queue.map(track => track.info.title), ['Song 9']);
  deleteGuildMusicData('g-minus-active');
});

test('the - button shows a private short-lived notice when nothing can be removed', async () => {
  const { client } = fakeBot();
  const ui = fakeUi('g-minus-empty');
  await openRemovePlaylistPanel(ui.make('music_remove', 'button', { reply: async payload => { ui.log.root = payload; } }), client);
  assert.equal(ui.log.modals.length, 0);
  assert.match(ui.log.root.embeds[0].toJSON().description, /Nothing is available to remove/);
  deleteGuildMusicData('g-minus-empty');
});

test('Stop ends the session: the list, the queue and the jam are gone', async () => {
  const { destroyPlayerSession } = await import('../src/services/music/musicActions.js');
  const { client, player } = fakeBot(byQuery);
  const ui = fakeUi('g-close');
  await addPlaylist(client, 'g-close', { url: 'https://x/playlist-1', name: 'One', count: 2, kind: 'playlist', ownerId: 'owner', ownerName: 'Mila' });
  await playQuery(client, ui.make('play', 'command'), 'https://open.spotify.com/playlist/road');
  await destroyPlayerSession(client, 'g-close', player, getGuildMusicData('g-close'));
  assert.deepEqual(await listPlaylists(client, 'g-close'), []);
  assert.equal(player.queue.length, 0);
  const form = await open(client, ui);
  assert.equal(form.components[0].content, `**Your list**\n${MAX_NOTE}\nYour list is empty. Add a song or a playlist below.`);
  deleteGuildMusicData('g-close');
});

test('Add opens one form at once with the list, a song or playlist field, Start and Remove', async () => {
  const { client } = fakeBot();
  const ui = fakeUi('g-form');
  let form = await open(client, ui);
  assert.equal(ui.log.root, null, 'no message before the form');
  assert.equal(form.title, 'Add to your list');
  assert.equal(form.components[0].content, `**Your list**\n${MAX_NOTE}\nYour list is empty. Add a song or a playlist below.`);
  assert.deepEqual(labels(form).map(label => [label.label, label.component.custom_id, label.component.required]),
    [['Add a song or playlist', 'add', false], ['Jam', 'jam', false]], 'an empty list has only the Add field and Jam');

  await addPlaylist(client, 'g-form', { url: 'https://x/1', name: 'Chill mix', count: 34, kind: 'playlist', ownerId: 'owner', ownerName: 'Mila' });
  await addPlaylist(client, 'g-form', { url: 'https://x/2', name: 'Blinding Lights', count: 1, kind: 'song', ownerId: 'owner', ownerName: 'Mila' });
  const firstId = form.custom_id;
  form = await open(client, ui);
  assert.notEqual(form.custom_id, firstId, 'every opening gets its own id');
  assert.equal(form.components[0].content, `**Your list**\n${MAX_NOTE}\n${WHITE} Chill mix · 34 songs\n${WHITE} Blinding Lights · song`);
  const [add, start, remove] = labels(form);
  assert.equal(add.label, 'Add a song or playlist');
  assert.deepEqual([start.label, start.component.custom_id, start.component.min_values, start.component.max_values, start.component.required],
    ['Start', 'start', 0, 1, false]);
  assert.deepEqual([remove.label, remove.component.custom_id, remove.component.min_values, remove.component.max_values, remove.component.required],
    ['Remove', 'remove', 0, 1, false], 'one choice: a tap selects at once');
  assert.deepEqual(remove.component.options.map(option => option.label), ['Chill mix', 'Blinding Lights']);
  assert.ok(labels(form).every(label => !label.description), 'no help lines under the fields');
  assert.equal(add.component.placeholder, 'Song name or playlist link');
});

test('a song name, a song link and a playlist link are each added to the list', async () => {
  const { client } = fakeBot(async ({ query }) => (query.includes('playlist')
    ? roadTrip()
    : { loadType: query.startsWith('http') ? 'track' : 'search', tracks: [track(7)] }));
  const ui = fakeUi('g-add');
  await submit(client, ui, await open(client, ui), { add: 'blinding lights' });
  assert.equal(ui.log.deferredReplies.length, 1, 'one private answer');
  assert.deepEqual(notice(ui).description, '**Song 7** was added · song.');
  await submit(client, ui, await open(client, ui), { add: 'https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl' });
  await submit(client, ui, await open(client, ui), { add: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' });
  assert.deepEqual(notice(ui).description, '**Road trip** was added · 2 songs.');
  const saved = await listPlaylists(client, 'g-add');
  assert.deepEqual(saved.map(item => [item.kind, item.url, item.count, item.ownerId]), [
    ['song', 'https://example.com/7', 1, 'owner'],
    ['song', 'https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl', 1, 'owner'],
    ['playlist', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 2, 'owner'],
  ]);
  assert.match((await open(client, ui)).components[0].content, /Road trip · 2 songs$/, 'the next Add shows it in the list');

  await submit(client, ui, await open(client, ui), { add: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' });
  assert.match(notice(ui).description, /already in your list/);
  assert.equal(ui.log.followUps.length, 0, 'never an extra message');
});

test('Start plays one from the list without any message, Remove removes the chosen one', async () => {
  const { client, player } = fakeBot();
  const ui = fakeUi('g-start');
  const one = await addPlaylist(client, 'g-start', { url: 'https://x/1', name: 'One', count: 2, ownerId: 'owner', ownerName: 'Mila' });
  const two = await addPlaylist(client, 'g-start', { url: 'https://x/2', name: 'Two', count: 2, ownerId: 'owner', ownerName: 'Mila' });

  await submit(client, ui, await open(client, ui), { start: [one.id] });
  assert.equal(player.current.info.title, 'Song 1', 'the playlist plays');
  assert.equal(player.queue.length, 1);
  assert.deepEqual([ui.log.deferredUpdates, ui.log.deferredReplies.length, ui.log.edits.length, ui.log.followUps.length], [1, 0, 0, 0],
    'the player panel shows the songs; nothing else is posted');

  await submit(client, ui, await open(client, ui), { remove: [two.id] });
  assert.equal(notice(ui).description, '**Two** was removed.');
  await submit(client, ui, await open(client, ui), { remove: [one.id] });
  assert.equal(notice(ui).description, '**One** was removed.');
  assert.deepEqual(await listPlaylists(client, 'g-start'), []);

  await submit(client, ui, await open(client, ui));
  assert.equal(ui.log.deferredUpdates, 2, 'an empty form just closes');
});

test('errors are private and go away after ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client } = fakeBot(async () => ({ loadType: 'empty', tracks: [] }));
  const ui = fakeUi('g-errors');
  const one = await addPlaylist(client, 'g-errors', { url: 'https://x/1', name: 'One', count: 1, ownerId: 'owner', ownerName: 'Mila' });

  await submit(client, ui, await open(client, ui), { add: 'zzzz no such song' });
  assert.equal(notice(ui).description, 'No song was found for **zzzz no such song**.');
  t.mock.timers.tick(10_000);
  await settle();
  assert.deepEqual(ui.log.deleted, ['@original']);

  await submit(client, ui, await open(client, ui), { add: 'https://open.spotify.com/track/missing' });
  assert.match(notice(ui).description, /That link could not be opened/);

  const other = { user: { id: 'other', username: 'Sam' }, memberPermissions: { has: () => false } };
  await submit(client, ui, await open(client, ui), { remove: [one.id] }, other);
  assert.equal(notice(ui).description, 'Only the person who added **One** or a moderator can remove it.');
  assert.equal((await listPlaylists(client, 'g-errors')).length, 1);

  const form = await open(client, ui);
  await removePlaylist(client, 'g-errors', one.id, { userId: 'owner' });
  await submit(client, ui, form, { start: [one.id] });
  assert.match(ui.log.followUps.at(-1).embeds[0].toJSON().description, /no longer in your list/);
  t.mock.timers.tick(10_000);
  await settle();
  assert.deepEqual(ui.log.removed, ['notice1'], 'the notice after a Start goes away too');
});

test('a list from before the update is answered without changes', async () => {
  const { client } = fakeBot();
  const ui = fakeUi('g-old');
  await addPlaylist(client, 'g-old', { url: 'https://x/1', name: 'One', count: 1, ownerId: 'owner', ownerName: 'Mila' });
  const old = ui.make('musicpl:delete:abc', 'button');
  assert.equal(await handleMusicPlaylistControls(old, client), true);
  assert.equal(ui.log.deferredUpdates, 1);
  assert.equal((await listPlaylists(client, 'g-old')).length, 1);
  assert.equal(await handleMusicPlaylistControls(ui.make('music_queue', 'button'), client), false);
});

test('a playlist started with /play shows in Add as Playing without being saved, and Start plays another one in its place', async () => {
  const { client, player } = fakeBot(byQuery);
  const ui = fakeUi('g-active');
  await playQuery(client, ui.make('play', 'command'), 'https://open.spotify.com/playlist/road');
  assert.deepEqual(await listPlaylists(client, 'g-active'), [], '/play keeps no history in the list');
  const chill = await addPlaylist(client, 'g-active', { url: 'https://x/playlist-chill', name: 'Chill mix', count: 2, kind: 'playlist', ownerId: 'owner', ownerName: 'Mila' });

  const form = await open(client, ui);
  assert.equal(form.components[0].content, `**Your list**\n${MAX_NOTE}\n${DOT} Playing: Road trip · 2 songs\n${WHITE} Chill mix · 2 songs`);
  const [, start, remove] = labels(form);
  assert.deepEqual(start.component.options.map(option => option.label), ['Chill mix']);
  assert.deepEqual(remove.component.options.map(option => [option.value, option.label, option.emoji.name, option.description]),
    [['active', 'Road trip', '🎵', '2 songs • playing'], [chill.id, 'Chill mix', '🎵', '2 songs • Mila']]);

  await submit(client, ui, form, { start: [chill.id] });
  assert.equal(player.stops, 1, 'the song that played is skipped');
  assert.equal(getGuildMusicData('g-active').endingTrack.outcome, 'skipped');
  assert.deepEqual(player.queue.map(song => song.cloudySource.url), ['https://x/playlist-chill', 'https://x/playlist-chill'], 'only the new playlist waits');
  assert.deepEqual([ui.log.edits.length, ui.log.followUps.length], [0, 0], 'no message');

  // The node starts the first song of Chill mix: it is on top, and Road trip is gone.
  player.play();
  const next = await open(client, ui);
  assert.equal(next.components[0].content, `**Your list**\n${MAX_NOTE}\n${DOT} Playing: Chill mix · 2 songs`);
  assert.deepEqual(labels(next).slice(1).map(label => label.component.options.map(option => option.label)),
    [['Chill mix'], ['Chill mix'], ['Start a jam']]);
  deleteGuildMusicData('g-active');
});

test('Remove of what plays takes its songs out of the queue; with nothing left the player stops', async () => {
  const { client, player } = fakeBot(byQuery);
  const ui = fakeUi('g-remove-active');
  await playQuery(client, ui.make('play', 'command'), 'https://open.spotify.com/playlist/road');
  await playQuery(client, ui.make('play', 'command'), 'another song');

  await submit(client, ui, await open(client, ui), { remove: ['active'] });
  assert.equal(notice(ui).description, '**Road trip** was removed.');
  assert.deepEqual(player.queue.map(song => song.info.title), ['Song 9'], 'the other song stays');
  assert.equal(player.stops, 1);
  assert.equal(getGuildMusicData('g-remove-active').endingTrack.outcome, 'stopped');
  assert.deepEqual(await listPlaylists(client, 'g-remove-active'), []);
  deleteGuildMusicData('g-remove-active');

  // With nothing else to play, Remove stops the player.
  const second = fakeBot(byQuery);
  const ui2 = fakeUi('g-remove-only');
  await playQuery(second.client, ui2.make('play', 'command'), 'https://open.spotify.com/playlist/road');
  const form = await open(second.client, ui2);
  assert.equal(form.components[0].content, `**Your list**\n${MAX_NOTE}\n${DOT} Playing: Road trip · 2 songs`);
  assert.deepEqual(labels(form).map(label => label.label), ['Add a song or playlist', 'Remove', 'Jam']);
  await submit(second.client, ui2, form, { remove: ['active'] });
  assert.equal(second.player.destroyed, true, 'nothing else to play: stopped like the Stop button');
  assert.equal(second.player.queue.length, 0);
  deleteGuildMusicData('g-remove-only');
});

test('a Start that cannot be opened leaves what plays and the queue as they were', async () => {
  let broken = false;
  const { client, player } = fakeBot(async args => (broken ? { loadType: 'empty', tracks: [] } : byQuery(args)));
  const ui = fakeUi('g-start-fail');
  await playQuery(client, ui.make('play', 'command'), 'https://open.spotify.com/playlist/road');
  const gone = await addPlaylist(client, 'g-start-fail', { url: 'https://x/gone', name: 'Gone', count: 3, kind: 'playlist', ownerId: 'owner', ownerName: 'Mila' });
  broken = true;
  await submit(client, ui, await open(client, ui), { start: [gone.id] });
  assert.match(ui.log.followUps.at(-1).embeds[0].toJSON().description, /No results|could not be opened/);
  assert.equal(player.stops, 0);
  assert.deepEqual(player.queue.map(song => song.info.title), ['Song 2']);
  deleteGuildMusicData('g-start-fail');
});

test('a song played with /play shows on top as Playing, and Remove stops it', async () => {
  const { client, player } = fakeBot(byQuery);
  const ui = fakeUi('g-plain');
  await addPlaylist(client, 'g-plain', { url: 'https://x/playlist-1', name: 'One', count: 2, kind: 'playlist', ownerId: 'owner', ownerName: 'Mila' });
  await playQuery(client, ui.make('play', 'command'), 'another song');
  const form = await open(client, ui);
  assert.equal(form.components[0].content, `**Your list**\n${MAX_NOTE}\n${DOT} Playing: Song 9 · song\n${WHITE} One · 2 songs`);
  const remove = labels(form).find(label => label.label === 'Remove');
  assert.deepEqual(remove.component.options.map(option => [option.value, option.label, option.emoji.name, option.description]),
    [['active', 'Song 9', '🎶', 'song • playing'], [(await listPlaylists(client, 'g-plain'))[0].id, 'One', '🎵', '2 songs • Mila']]);
  await submit(client, ui, form, { remove: ['active'] });
  assert.equal(notice(ui).description, '**Song 9** was removed.');
  assert.equal(player.destroyed, true, 'nothing else to play');
  assert.deepEqual(await listPlaylists(client, 'g-plain'), [], 'stopping like Stop ends the session, so the list is emptied too');
  deleteGuildMusicData('g-plain');
});

test('what waits in the queue shows as Queue with the blue dot, between Playing and the rest', async () => {
  const { client, player } = fakeBot(byQuery);
  const ui = fakeUi('g-queue');
  await addPlaylist(client, 'g-queue', { url: 'https://x/playlist-chill', name: 'Chill mix', count: 2, kind: 'playlist', ownerId: 'owner', ownerName: 'Mila' });
  await addPlaylist(client, 'g-queue', { url: 'https://x/hosselen', name: 'Hosselen', count: 1, kind: 'song', ownerId: 'owner', ownerName: 'Mila' });
  await playQuery(client, ui.make('play', 'command'), 'https://open.spotify.com/playlist/road');
  await playQuery(client, ui.make('play', 'command'), 'https://x/playlist-chill');
  await playQuery(client, ui.make('play', 'command'), 'another song');

  const form = await open(client, ui);
  assert.equal(form.components[0].content, [
    '**Your list**',
    MAX_NOTE,
    `${DOT} Playing: Road trip · 2 songs`,
    `${BLUE} Queue: Chill mix · 2 songs`,
    `${BLUE} Queue: Song 9 · song`,
    `${WHITE} Hosselen · song`,
  ].join('\n'));
  const [, start, remove] = labels(form);
  assert.deepEqual(start.component.options.map(option => option.label), ['Chill mix', 'Hosselen']);
  assert.deepEqual(remove.component.options.map(option => [option.label, option.description]), [
    ['Road trip', '2 songs • playing'], ['Chill mix', '2 songs • queue'], ['Song 9', 'song • queue'], ['Hosselen', 'song • Mila'],
  ]);

  // Remove of a song that waits in the queue takes only that song out.
  const song9 = remove.component.options[2].value;
  assert.match(song9, /^q:[0-9a-f]{16}$/);
  await submit(client, ui, form, { remove: [song9] });
  assert.equal(notice(ui).description, '**Song 9** was removed.');
  assert.deepEqual(player.queue.map(song => song.info.title), ['Song 2', 'Song 1', 'Song 2']);
  assert.equal(player.stops, 0, 'what plays keeps playing');
  deleteGuildMusicData('g-queue');
});

test('at most 10 songs or playlists wait in the queue; Start still replaces', async () => {
  const resolve = async ({ query }) => (/playlist/.test(query) ? roadTrip() : { loadType: 'search', tracks: [track(query)] });
  const { client, player } = fakeBot(resolve);
  const ui = fakeUi('g-full');
  await playQuery(client, ui.make('play', 'command'), 'first');
  for (let n = 1; n <= 10; n += 1) await playQuery(client, ui.make('play', 'command'), 'song ' + n);
  assert.equal(player.queue.length, 10);
  await assert.rejects(playQuery(client, ui.make('play', 'command'), 'one too many'),
    error => /queue is full: at most 10 songs or playlists/.test(error.userMessage));
  assert.equal(player.queue.length, 10, 'nothing was added');

  const mix = await addPlaylist(client, 'g-full', { url: 'https://x/playlist-mix', name: 'Mix', count: 2, kind: 'playlist', ownerId: 'owner', ownerName: 'Mila' });
  await submit(client, ui, await open(client, ui), { start: [mix.id] });
  assert.deepEqual(player.queue.map(song => song.cloudySource.url), ['https://x/playlist-mix', 'https://x/playlist-mix'], 'Start replaces the full queue');
  deleteGuildMusicData('g-full');
});

test('a jam works like Spotify: one queue in the order songs are added, the host ends it', async () => {
  const { client, player } = fakeBot(async ({ query }) => ({ loadType: 'search', tracks: [track(query)] }));
  const ui = fakeUi('g-jam');
  const sam = { user: { id: 'sam', username: 'Sam' }, memberPermissions: { has: () => false } };
  await playQuery(client, ui.make('play', 'command'), 'first song');
  await addPlaylist(client, 'g-jam', { url: 'https://x/playlist-1', name: 'One', count: 2, kind: 'playlist', ownerId: 'owner', ownerName: 'Mila' });
  let form = await open(client, ui);
  const jamField = labels(form).find(label => label.label === 'Jam');
  assert.deepEqual(jamField.component.options.map(option => [option.value, option.label, option.description, option.emoji]),
    [['start', 'Start a jam', 'Everyone in the voice channel can add songs', undefined]]);
  assert.equal(jamField.component.placeholder, 'Choose to start a jam');

  await submit(client, ui, form, { jam: ['start'] });
  assert.equal(notice(ui).description, 'Jam started: everyone in the voice channel can add songs.');
  assert.equal(getGuildMusicData('g-jam').jam.hostName, 'Mila');

  // Everyone adds; the songs wait in the order they were added, with who added them.
  await playQuery(client, ui.make('play', 'command'), 'mila one');
  form = await open(client, ui, sam);
  assert.deepEqual(labels(form).map(label => label.label), ['Add to the jam', 'Add from your list', 'Remove', 'Jam']);
  await submit(client, ui, form, { add: 'sam one' }, sam);
  assert.equal(notice(ui).description, '**Song sam one** was added to the jam.');
  await playQuery(client, ui.make('play', 'command'), 'mila two');
  assert.deepEqual(player.queue.map(t => t.info.title), ['Song mila one', 'Song sam one', 'Song mila two']);

  form = await open(client, ui);
  assert.equal(form.components[0].content, [
    '**Your list**',
    "-# Mila's Jam · max 10 songs or playlists in the queue",
    `${DOT} Playing: Song first song · song · Mila`,
    `${BLUE} Queue: Song mila one · song · Mila`,
    `${BLUE} Queue: Song sam one · song · Sam`,
    `${BLUE} Queue: Song mila two · song · Mila`,
    `${WHITE} One · 2 songs`,
  ].join('\n'));

  // Everyone may choose the song that plays now; only the host (or a moderator) can end it.
  const hostPicks = labels(form).at(-1).component;
  assert.equal(hostPicks.placeholder, 'Choose a song to play now');
  assert.deepEqual(hostPicks.options.map(option => [option.label, option.description]),
    [['Song mila one', 'Mila'], ['Song sam one', 'Sam'], ['Song mila two', 'Mila'], ['End the jam', 'Stops the music for everyone']]);
  const samForm = await open(client, ui, sam);
  const samPicks = labels(samForm).at(-1).component;
  assert.deepEqual(samPicks.options.map(option => option.label), ['Song mila one', 'Song sam one', 'Song mila two'], 'no End the jam for a guest');

  const stopsBefore = player.stops;
  const editsBefore = ui.log.edits.length;
  await submit(client, ui, samForm, { jam: [samPicks.options[2].value] }, sam);
  assert.deepEqual(player.queue.map(t => t.info.title), ['Song mila two', 'Song mila one', 'Song sam one']);
  assert.equal(player.stops, stopsBefore + 1, 'the song that played is skipped');
  assert.equal(ui.log.edits.length, editsBefore, 'no message: the player shows it');

  await submit(client, ui, samForm, { jam: ['end'] }, sam);
  assert.match(notice(ui).description, /Only the host of the jam or a moderator can end it/);
  assert.ok(getGuildMusicData('g-jam').jam, 'a guest cannot end it');

  // The host ends it: the whole session closes and nothing is kept.
  await submit(client, ui, await open(client, ui), { jam: ['end'] });
  assert.equal(notice(ui).description, 'The jam has ended.');
  assert.equal(getGuildMusicData('g-jam').jam, null);
  assert.equal(player.destroyed, true, 'the music stops like Stop');
  assert.deepEqual(await listPlaylists(client, 'g-jam'), [], 'the list is gone too');
  deleteGuildMusicData('g-jam');
});

test('the jam ends when its host stays out of the voice channel for 30 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watchJamHost, JAM_HOST_AWAY_MS } = await import('../src/services/music/musicActions.js');
  const { client, player } = fakeBot(byQuery);
  const ui = fakeUi('g-host');
  await playQuery(client, ui.make('play', 'command'), 'first song');
  await submit(client, ui, await open(client, ui), { jam: ['start'] });
  const leave = { id: 'owner', channelId: 'voice' };
  const away = { id: 'owner', channelId: null };
  watchJamHost(client, 'g-host', player, leave, away);
  t.mock.timers.tick(JAM_HOST_AWAY_MS - 1000);
  watchJamHost(client, 'g-host', player, away, leave);
  t.mock.timers.tick(5_000);
  assert.ok(getGuildMusicData('g-host').jam, 'back in time: the jam goes on');
  watchJamHost(client, 'g-host', player, leave, away);
  t.mock.timers.tick(JAM_HOST_AWAY_MS);
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(getGuildMusicData('g-host').jam, null);
  assert.equal(player.destroyed, true);
  deleteGuildMusicData('g-host');
});

test('every line of the list stays on one line: a long name is shortened', async () => {
  const { client } = fakeBot();
  const ui = fakeUi('g-long');
  await addPlaylist(client, 'g-long', { url: 'https://x/long', name: 'The Most Beautiful Songs Of The Whole Summer 2026 Edition', count: 120, kind: 'playlist', ownerId: 'owner', ownerName: 'Mila' });
  const form = await open(client, ui);
  const line = form.components[0].content.split('\n').at(-1);
  assert.equal(line, `${WHITE} The Most Beautiful Songs Of… · 120 songs`);
  assert.ok(line.slice(WHITE.length + 1).length <= 40);
  // The choices keep the whole name.
  assert.equal(labels(form)[1].component.options[0].label, 'The Most Beautiful Songs Of The Whole Summer 2026 Edition');
});
