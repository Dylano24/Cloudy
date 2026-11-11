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
  const log = { updates: [], edits: [], followUps: [], modals: [], deleted: [], removed: [], root: null };
  const make = (customId, kind, extra = {}) => ({
    customId, guildId, user: { id: 'owner', username: 'Mila' },
    guild: { id: guildId }, channel: { id: 'text' }, member: { voice: { channel: { id: 'voice' } } },
    memberPermissions: { has: permission => permission === PermissionFlagsBits.ManageGuild },
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'string',
    isAnySelectMenu: () => kind === 'string',
    isModalSubmit: () => kind === 'modal',
    deferUpdate: async () => {},
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
  await openPlaylistPanel(ui.make('', 'command', { reply: async payload => { ui.log.root = payload; } }), client);
  const sid = ui.log.root.components.at(-1).toJSON().components[0].custom_id.split(':')[2];
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

test('the panel adds a playlist by link and starts it without searching again', async t => {
  const { client, player } = fakeBot();
  const ui = fakeUi('g-flow');
  const panel = await open(client, ui, 'g-flow');
  assert.deepEqual(ui.log.root.components.map(row => row.toJSON().components.map(item => item.label || item.placeholder)), [['Add playlist', 'Remove']]);

  await panel.press('add', 'button');
  assert.equal(ui.log.modals[0].toJSON().title, 'Add playlist');
  await panel.press('modal', 'modal', modal('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'));
  const [saved] = await listPlaylists(client, 'g-flow');
  assert.deepEqual([saved.name, saved.count, saved.ownerId], ['Road trip', 2, 'owner']);
  assert.equal(ui.log.followUps[0].embeds[0].toJSON().title, 'Playlist added');
  // Right after Add the new playlist is shown with Start and Delete.
  assert.deepEqual(ui.log.edits.at(-1).components[0].toJSON().components.map(button => button.label), ['Start', 'Delete', 'Back']);
  assert.match(ui.log.edits.at(-1).embeds[0].toJSON().description, /Road trip/);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  await panel.press('play', 'button');
  assert.equal(player.queue.length, 2);
  assert.equal(ui.log.edits.at(-1).embeds[0].toJSON().title, 'Playlist added');
  assert.deepEqual(ui.log.edits.at(-1).components, []);
  t.mock.timers.tick(10_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ui.log.deleted, ['reply'], 'the confirmation removes itself after ten seconds');
});

test('a link that is not a playlist gives a clear private notice', async () => {
  const { client } = fakeBot(async () => ({ loadType: 'track', tracks: [track(1)] }));
  const ui = fakeUi('g-errors');
  const panel = await open(client, ui, 'g-errors');
  await panel.press('modal', 'modal', modal('just some words'));
  const first = ui.log.followUps[0].embeds[0].toJSON();
  assert.equal(first.title, 'Playlist error');
  assert.match(first.description, /Paste the link of a playlist or album/);
  await panel.press('modal', 'modal', modal('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl'));
  assert.match(ui.log.followUps[1].embeds[0].toJSON().description, /single song/);
  assert.deepEqual(await listPlaylists(client, 'g-errors'), []);
});

test('a playlist is removed in two steps and only its panel opener can use the controls', async () => {
  const { client } = fakeBot();
  const ui = fakeUi('g-remove');
  await addPlaylist(client, 'g-remove', { url: 'https://x/1', name: 'One', count: 1, ownerId: 'owner', ownerName: 'Mila' });
  const panel = await open(client, ui, 'g-remove');
  const before = ui.log.updates.length;
  await handleMusicPlaylistControls(ui.make('musicpl:remove:' + panel.sid, 'button', { user: { id: 'other', username: 'Sam' } }), client);
  assert.equal(ui.log.updates.length, before, 'another member cannot use the panel');

  await panel.press('remove', 'button');
  assert.equal(ui.log.updates.at(-1).components[0].toJSON().components[0].placeholder, 'Remove a playlist');
  const [item] = await listPlaylists(client, 'g-remove');
  await panel.press('removepick', 'string', { values: [item.id] });
  assert.deepEqual(await listPlaylists(client, 'g-remove'), []);
  assert.equal(ui.log.followUps.at(-1).embeds[0].toJSON().title, 'Playlist removed');
});

test('a playlist just added can be deleted at once from its Start/Delete view', async () => {
  const { client } = fakeBot();
  const ui = fakeUi('g-saved-delete');
  const panel = await open(client, ui, 'g-saved-delete');
  await panel.press('modal', 'modal', modal('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'));
  assert.equal((await listPlaylists(client, 'g-saved-delete')).length, 1);
  await panel.press('delete', 'button');
  assert.deepEqual(await listPlaylists(client, 'g-saved-delete'), []);
  assert.equal(ui.log.followUps.at(-1).embeds[0].toJSON().title, 'Playlist removed');
  assert.deepEqual(ui.log.edits.at(-1).components.map(row => row.toJSON().components.map(item => item.label || item.placeholder)), [['Add playlist', 'Remove']], 'back on the main panel');
});
