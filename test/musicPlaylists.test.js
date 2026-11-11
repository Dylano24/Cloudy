import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  addPlaylist, listPlaylists, removePlaylist, openPlaylistPanel, handleMusicPlaylistControls,
} from '../src/services/music/musicPlaylists.js';

const track = n => ({ info: { title: 'Song ' + n, author: 'Artist', uri: 'https://example.com/' + n, length: 1000 } });
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
      resolve: resolve || (async () => ({ loadType: 'playlist', playlistInfo: { name: 'Road trip' }, tracks: [track(1), track(2)] })),
    },
  };
  return { client, data, player };
}
function fakeUi(guildId) {
  const log = { updates: [], edits: [], followUps: [], modals: [], deleted: [], removed: [], deferredReplies: [], root: null };
  const make = (customId, kind, extra = {}) => ({
    customId, guildId, user: { id: 'owner', username: 'Mila' },
    guild: { id: guildId }, channel: { id: 'text' }, member: { voice: { channel: { id: 'voice' } } },
    memberPermissions: { has: permission => permission === PermissionFlagsBits.ManageGuild },
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'string',
    isAnySelectMenu: () => kind === 'string',
    isModalSubmit: () => kind === 'modal',
    deferred: false,
    async deferUpdate() { this.deferred = true; },
    async deferReply(options) { this.deferred = true; log.deferredReplies.push(options); },
    update: async payload => { log.updates.push(payload); },
    editReply: async payload => { log.edits.push(payload); },
    deleteReply: async () => { log.deleted.push('reply'); },
    showModal: async modal => { log.modals.push(modal); },
    followUp: async payload => { log.followUps.push(payload); return { id: 'notice' + log.followUps.length }; },
    webhook: { deleteMessage: async id => { log.removed.push(id); } },
    ...extra,
  });
  return { log, make };
}
async function open(client, ui, guildId) {
  // The player's Add button opens the form at once.
  await openPlaylistPanel(ui.make('music_playlists', 'button', { reply: async payload => { ui.log.root = payload; } }), client);
  const sid = ui.log.modals.at(-1).toJSON().custom_id.split(':')[2];
  const press = (type, kind, extra) => handleMusicPlaylistControls(ui.make('musicpl:' + type + ':' + sid, kind, extra), client);
  return { sid, press };
}
const modal = (link, name = '') => ({ fields: { getTextInputValue: field => (field === 'link' ? link : name) } });

test('playlists are saved per server with limits, and only the owner or a moderator removes one', async () => {
  const { client, data } = fakeBot();
  const a = await addPlaylist(client, 'g-store', { url: 'https://open.spotify.com/playlist/a', name: 'A', count: 3, ownerId: 'u1', ownerName: 'Mila' });
  assert.ok(data.has('guild:g-store:music-playlists'), 'stored under the server key in the database');
  await assert.rejects(addPlaylist(client, 'g-store', { url: 'https://open.spotify.com/playlist/a', name: 'Again', count: 1, ownerId: 'u2', ownerName: 'Sam' }), error => /already saved/.test(error.userMessage));
  for (let n = 1; n < 10; n += 1) await addPlaylist(client, 'g-store', { url: 'https://x/' + n, name: 'P' + n, count: 1, ownerId: 'u1', ownerName: 'Mila' });
  await assert.rejects(addPlaylist(client, 'g-store', { url: 'https://x/extra', name: 'Extra', count: 1, ownerId: 'u1', ownerName: 'Mila' }), error => /up to 10/.test(error.userMessage));
  assert.equal((await listPlaylists(client, 'g-store')).length, 10);
  assert.deepEqual(await removePlaylist(client, 'g-store', a.id, { userId: 'u2' }), { removed: false, reason: 'forbidden' });
  assert.equal((await removePlaylist(client, 'g-store', a.id, { userId: 'u2', canManage: true })).removed, true);
  assert.deepEqual(await removePlaylist(client, 'g-store', a.id, { userId: 'u1' }), { removed: false, reason: 'missing' });
});

test('Add opens the form at once; the list after it starts the playlist without searching again', async () => {
  const { client, player } = fakeBot();
  const ui = fakeUi('g-flow');
  const panel = await open(client, ui, 'g-flow');
  assert.equal(ui.log.modals[0].toJSON().title, 'Add playlist');
  assert.equal(ui.log.root, null, 'no panel message before the form');

  await panel.press('modal', 'modal', modal('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'));
  assert.equal(ui.log.deferredReplies.length, 1, 'the list is a new private answer');
  const [saved] = await listPlaylists(client, 'g-flow');
  assert.deepEqual([saved.name, saved.count, saved.ownerId], ['Road trip', 2, 'owner']);
  assert.equal(ui.log.followUps.length, 0, 'no extra message');
  const list = ui.log.edits.at(-1);
  assert.match(list.embeds[0].toJSON().description, /\*\*Road trip\*\* was added · 2 songs/);
  assert.deepEqual(list.components.map(row => row.toJSON().components.map(item => item.label || item.placeholder)),
    [['Choose a playlist'], ['Start', 'Delete', 'Add']]);
  assert.equal(list.components[0].toJSON().components[0].options.find(option => option.default).value, saved.id);

  await panel.press('play', 'button');
  assert.equal(player.queue.length, 2);
  assert.deepEqual(ui.log.deleted, ['reply'], 'the list goes away; the player shows the songs');
});

test('an empty link shows the saved playlists to start or delete', async () => {
  const { client } = fakeBot();
  await addPlaylist(client, 'g-empty', { url: 'https://x/1', name: 'One', count: 1, ownerId: 'owner', ownerName: 'Mila' });
  const ui = fakeUi('g-empty');
  const panel = await open(client, ui, 'g-empty');
  await panel.press('modal', 'modal', modal(''));
  assert.equal((await listPlaylists(client, 'g-empty')).length, 1, 'nothing added');
  assert.deepEqual(ui.log.edits.at(-1).components[1].toJSON().components.map(button => button.label), ['Start', 'Delete', 'Add']);
});

test('a link that is not a playlist answers privately and goes away after ten seconds', async t => {
  const { client } = fakeBot(async () => ({ loadType: 'track', tracks: [track(1)] }));
  const ui = fakeUi('g-errors');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let panel = await open(client, ui, 'g-errors');
  await panel.press('modal', 'modal', modal('just some words'));
  const first = ui.log.edits.at(-1).embeds[0].toJSON();
  assert.equal(first.title, 'Playlist error');
  assert.match(first.description, /Paste the link of a playlist or album/);
  t.mock.timers.tick(10_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ui.log.deleted, ['reply']);
  panel = await open(client, ui, 'g-errors');
  await panel.press('modal', 'modal', modal('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl'));
  assert.match(ui.log.edits.at(-1).embeds[0].toJSON().description, /single song/);
  assert.deepEqual(await listPlaylists(client, 'g-errors'), []);
});

test('Delete removes the chosen playlist, and only the opener can use the list', async () => {
  const { client } = fakeBot();
  const ui = fakeUi('g-remove');
  await addPlaylist(client, 'g-remove', { url: 'https://x/1', name: 'One', count: 1, ownerId: 'owner', ownerName: 'Mila' });
  await addPlaylist(client, 'g-remove', { url: 'https://x/2', name: 'Two', count: 2, ownerId: 'owner', ownerName: 'Mila' });
  const panel = await open(client, ui, 'g-remove');
  await panel.press('modal', 'modal', modal(''));
  const two = (await listPlaylists(client, 'g-remove')).find(item => item.name === 'Two');
  await panel.press('pick', 'string', { values: [two.id] });
  assert.equal(ui.log.updates.at(-1).components[0].toJSON().components[0].options.find(option => option.default).value, two.id);

  await handleMusicPlaylistControls(ui.make('musicpl:delete:' + panel.sid, 'button', { user: { id: 'other', username: 'Sam' } }), client);
  assert.equal((await listPlaylists(client, 'g-remove')).length, 2, 'another member cannot use the list');

  await panel.press('delete', 'button');
  assert.deepEqual((await listPlaylists(client, 'g-remove')).map(item => item.name), ['One']);
  assert.match(ui.log.edits.at(-1).embeds[0].toJSON().description, /\*\*Two\*\* was deleted/);
  assert.equal(ui.log.followUps.length, 0, 'no extra message');
});
