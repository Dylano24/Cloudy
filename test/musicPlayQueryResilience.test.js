import test from 'node:test';
import assert from 'node:assert/strict';
import { playQuery } from '../src/services/music/musicActions.js';

function setup(resolve) {
  const player = { setVolume() {}, queue: [], playing: false, paused: false };
  const client = { riffy: { players: new Map(), createConnection: () => player, get: () => player, resolve } };
  const interaction = {
    guild: { id: 'music-resilience-guild' },
    channel: { id: 'text' },
    user: { id: 'member' },
    member: { voice: { channel: { id: 'voice' } } },
  };
  return { client, interaction };
}

test('play shows a clear music-server message when the node answers without a body', async () => {
  const { client, interaction } = setup(async () => {
    throw new TypeError("Cannot read properties of null (reading 'loadType')");
  });
  await assert.rejects(playQuery(client, interaction, 'some song'), error => {
    assert.equal(error.name, 'CloudyError');
    assert.equal(error.type, 'network');
    assert.match(error.userMessage, /music server is not responding/);
    return true;
  });
});

test('play treats an empty resolve result as an unavailable music server', async () => {
  const { client, interaction } = setup(async () => null);
  await assert.rejects(playQuery(client, interaction, 'some song'), error => {
    assert.equal(error.type, 'network');
    return true;
  });
});
