import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  addPlaylist, listPlaylists, removePlaylist, openPlaylistPanel, handleMusicPlaylistControls,
} from '../src/services/music/musicPlaylists.js';

const track = n => ({ info: { title: 'Song ' + n, author: 'Artist', uri: 'https://example.com/' + n, length: 1000 } });
const roadTrip = () => ({ loadType: 'playlist', playlistInfo: { name: 'Road trip' }, tracks: [track(1), track(2)] });
function fakeBot(resolve) {
  const data = new Map();
  const player = { queue: Object.assign([], { add(item) { this.push(item); } }), playing: false, paused: false, setVolume() {}, play() { this.playing = true; } };
  const client = {
    db: {
      get: async key => structuredClone(data.get(key) ?? null),
      set: async (key, value) => { data.set(key, structuredClone(value)); return true; },
    },
    riffy: {
      players: new Map(),
      createConnection: () => player,
      resolve: resolve || (async () => roadTrip()),
    },
  };
  return { client, data, player };
}
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
async function open(client, ui) {
  await openPlaylistPanel(ui.make('music_playlists', 'button', { reply: async payload => { ui.log.root = payload; } }), client);
  return ui.log.modals.at(-1);
}
function submit(client, ui, form, { add = '', start = [], remove = [] } = {}, extra = {}) {
  const fields = {
    getTextInputValue: id => (id === 'add' ? add : ''),
    getStringSelectValues: id => ({ start, remove })[id] || [],
  };
  return handleMusicPlaylistControls(ui.make(form.custom_id, 'modal', { fields, ...extra }), client);
}
const labels = form => form.components.filter(item => item.type === 18);
const notice = ui => ui.log.edits.at(-1).embeds[0].toJSON();
const settle = () => new Promise(resolve => setImmediate(resolve));

test('songs and playlists are saved per server with limits, and only the owner or a moderator removes one', async () => {
  const { client, data } = fakeBot();
  const a = await addPlaylist(client, 'g-store', { url: 'https://open.spotify.com/playlist/a', name: 'A', count: 3, ownerId: 'u1', ownerName: 'Mila' });
  assert.ok(data.has('guild:g-store:music-playlists'), 'stored under the server key in the database');
  await assert.rejects(addPlaylist(client, 'g-store', { url: 'https://open.spotify.com/playlist/a', name: 'Again', count: 1, ownerId: 'u2', ownerName: 'Sam' }), error => /already in your list/.test(error.userMessage));
  for (let n = 1; n < 10; n += 1) await addPlaylist(client, 'g-store', { url: 'https://x/' + n, name: 'P' + n, count: 1, ownerId: 'u1', ownerName: 'Mila' });
  await assert.rejects(addPlaylist(client, 'g-store', { url: 'https://x/extra', name: 'Extra', count: 1, ownerId: 'u1', ownerName: 'Mila' }), error => /up to 10/.test(error.userMessage));
  assert.equal((await listPlaylists(client, 'g-store')).length, 10);
  assert.deepEqual(await removePlaylist(client, 'g-store', a.id, { userId: 'u2' }), { removed: false, reason: 'forbidden' });
  assert.equal((await removePlaylist(client, 'g-store', a.id, { userId: 'u2', canManage: true })).removed, true);
  assert.deepEqual(await removePlaylist(client, 'g-store', a.id, { userId: 'u1' }), { removed: false, reason: 'missing' });
});

test('Add opens one form at once with the list, a song or playlist field, Start and Remove', async () => {
  const { client } = fakeBot();
  const ui = fakeUi('g-form');
  let form = await open(client, ui);
  assert.equal(ui.log.root, null, 'no message before the form');
  assert.equal(form.title, 'Add to your list');
  assert.match(form.components[0].content, /Your list is empty/);
  assert.deepEqual(labels(form).map(label => [label.label, label.component.custom_id, label.component.required]),
    [['Add a song or playlist', 'add', false]], 'an empty list has only the Add field');

  await addPlaylist(client, 'g-form', { url: 'https://x/1', name: 'Chill mix', count: 34, kind: 'playlist', ownerId: 'owner', ownerName: 'Mila' });
  await addPlaylist(client, 'g-form', { url: 'https://x/2', name: 'Blinding Lights', count: 1, kind: 'song', ownerId: 'owner', ownerName: 'Mila' });
  const firstId = form.custom_id;
  form = await open(client, ui);
  assert.notEqual(form.custom_id, firstId, 'every opening gets its own id');
  assert.equal(form.components[0].content, '**Your list**\n1. Chill mix · 34 songs\n2. Blinding Lights · song');
  const [add, start, remove] = labels(form);
  assert.equal(add.label, 'Add a song or playlist');
  assert.deepEqual([start.label, start.component.custom_id, start.component.min_values, start.component.max_values, start.component.required],
    ['Start', 'start', 0, 1, false]);
  assert.deepEqual([remove.label, remove.component.custom_id, remove.component.min_values, remove.component.max_values, remove.component.required],
    ['Remove', 'remove', 0, 2, false]);
  assert.deepEqual(remove.component.options.map(option => option.label), ['Chill mix', 'Blinding Lights']);
  assert.ok(labels(form).every(label => !label.description), 'no help lines under the fields');
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
  assert.match((await open(client, ui)).components[0].content, /3\. Road trip · 2 songs/, 'the next Add shows it in the list');

  await submit(client, ui, await open(client, ui), { add: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' });
  assert.match(notice(ui).description, /already in your list/);
  assert.equal(ui.log.followUps.length, 0, 'never an extra message');
});

test('Start plays one from the list without any message, Remove removes several at once', async () => {
  const { client, player } = fakeBot();
  const ui = fakeUi('g-start');
  const one = await addPlaylist(client, 'g-start', { url: 'https://x/1', name: 'One', count: 2, ownerId: 'owner', ownerName: 'Mila' });
  const two = await addPlaylist(client, 'g-start', { url: 'https://x/2', name: 'Two', count: 2, ownerId: 'owner', ownerName: 'Mila' });

  await submit(client, ui, await open(client, ui), { start: [one.id] });
  assert.equal(player.queue.length, 2, 'the playlist is loaded');
  assert.deepEqual([ui.log.deferredUpdates, ui.log.deferredReplies.length, ui.log.edits.length, ui.log.followUps.length], [1, 0, 0, 0],
    'the player panel shows the songs; nothing else is posted');

  await submit(client, ui, await open(client, ui), { remove: [one.id, two.id] });
  assert.deepEqual(await listPlaylists(client, 'g-start'), []);
  assert.equal(notice(ui).description, '**One** was removed.\n**Two** was removed.');

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
