import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { finishRequestMessage, rememberRequestMessage, lastFinishedTrack } from '../src/services/music/musicRequestMessages.js';
import { setupPlayerHandler } from '../src/services/music/playerHandler.js';

function fakeClient() {
  const edits = [];
  const message = { id: 'm1', embeds: [{ title: 'Now playing', description: 'Song', color: 0xFFFFFF }], edit: async payload => { edits.push(payload); } };
  const channel = { messages: { fetch: async id => (id === 'm1' ? message : null) } };
  return { client: { channels: { cache: new Map([['c1', channel]]) }, riffy: new EventEmitter() }, edits };
}
const titleOf = payload => payload.embeds[0].toJSON().title;
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a finished song turns its public message into Played, once', async () => {
  const { client, edits } = fakeClient();
  const track = { info: { title: 'Song' } };
  await rememberRequestMessage(client, track, { id: 'm1', channelId: 'c1' });
  assert.equal(await finishRequestMessage(client, track), true);
  assert.equal(titleOf(edits[0]), 'Played');
  assert.equal(edits[0].embeds[0].toJSON().description, 'Song', 'the rest of the message stays as it was');
  await finishRequestMessage(client, track);
  assert.equal(edits.length, 1);
});

test('a song that fails or ends before the reply was sent is still updated', async () => {
  const { client, edits } = fakeClient();
  const track = { info: { title: 'Song' } };
  assert.equal(await finishRequestMessage(client, track, 'failed'), false);
  assert.equal(edits.length, 0);
  await rememberRequestMessage(client, track, { id: 'm1', channelId: 'c1' });
  assert.equal(titleOf(edits[0]), 'Could not play');
});

test('trackEnd updates the message, except for a song that repeats', async () => {
  const { client, edits } = fakeClient();
  setupPlayerHandler(client);
  const track = { info: { title: 'Song' } };
  await rememberRequestMessage(client, track, { id: 'm1', channelId: 'c1' });
  client.riffy.emit('trackEnd', { loop: 'track' }, track, { reason: 'finished' });
  await tick();
  assert.equal(edits.length, 0, 'a song on repeat is still playing');
  client.riffy.emit('trackEnd', { loop: 'none' }, track, { reason: 'finished' });
  await tick();
  assert.equal(titleOf(edits[0]), 'Played');
});

test('the very last song is found through the player history', () => {
  assert.equal(lastFinishedTrack({ previous: { info: { title: 'A' } } }).info.title, 'A');
  assert.equal(lastFinishedTrack({ previous: [{ info: { title: 'A' } }, { info: { title: 'B' } }] }).info.title, 'B');
  assert.equal(lastFinishedTrack({}), null);
});
