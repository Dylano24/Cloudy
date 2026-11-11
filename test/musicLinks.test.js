import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMusicLink, expandShortLink, prepareMusicQuery } from '../src/services/music/musicLinks.js';
import { playQuery } from '../src/services/music/musicActions.js';

test('pasted links are cleaned: share text, Spotify URIs and old iTunes links', () => {
  assert.equal(extractMusicLink('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'https://youtu.be/dQw4w9WgXcQ?si=abc');
  assert.equal(extractMusicLink('<https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl>'), 'https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl');
  assert.equal(extractMusicLink('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'), 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(extractMusicLink('Listen to this on Apple Music (https://music.apple.com/nl/song/x/1542842761).'), 'https://music.apple.com/nl/song/x/1542842761');
  assert.equal(extractMusicLink('https://itunes.apple.com/us/album/x/1542842760?i=1542842761'), 'https://music.apple.com/us/album/x/1542842760?i=1542842761');
  assert.equal(extractMusicLink('https://geo.music.apple.com/us/album/x/1?i=2'), 'https://music.apple.com/us/album/x/1?i=2');
});

test('song names are not treated as links', async () => {
  assert.equal(extractMusicLink('never gonna give you up'), null);
  assert.equal(extractMusicLink('   '), null);
  assert.deepEqual(await prepareMusicQuery('  daft punk  '), { query: 'daft punk', isLink: false });
  assert.deepEqual(await prepareMusicQuery('https://music.youtube.com/watch?v=dQw4w9WgXcQ'),
    { query: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', isLink: true });
});

test('short links expand only on known hosts and only to music hosts', async () => {
  const calls = [];
  const redirect = location => async url => { calls.push(url); return { status: 302, headers: { get: () => location } }; };
  assert.equal(await expandShortLink('https://spotify.link/abc', redirect('https://open.spotify.com/track/1?si=x')), 'https://open.spotify.com/track/1?si=x');
  assert.equal(await expandShortLink('https://spotify.link/abc', redirect('https://evil.example/x')), 'https://spotify.link/abc');
  assert.equal(await expandShortLink('https://spotify.link/abc', redirect('http://open.spotify.com/track/1')), 'https://spotify.link/abc');
  calls.length = 0;
  assert.equal(await expandShortLink('https://example.com/a', redirect('https://open.spotify.com/track/1')), 'https://example.com/a');
  assert.equal(calls.length, 0, 'unknown hosts are never fetched');
  assert.equal(await expandShortLink('https://spotify.link/abc', async () => { throw new Error('offline'); }), 'https://spotify.link/abc');
});

const track = (title = 'Song') => ({ info: { title, author: 'Artist', uri: 'https://example.com/' + title, length: 1000 } });
function makePlayer(node) {
  const queue = [];
  queue.add = item => queue.push(item);
  return { node, queue, playing: false, paused: false, setVolume() {}, play() { this.playing = true; } };
}
function setup(guildId, riffyParts) {
  const client = { riffy: { players: new Map(), ...riffyParts } };
  const interaction = {
    guild: { id: guildId }, channel: { id: 'text' }, user: { id: 'member' },
    member: { voice: { channel: { id: 'voice' } } },
  };
  return { client, interaction };
}

test('YouTube, Spotify and Apple Music links are no longer blocked', async () => {
  for (const link of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl', 'https://music.apple.com/us/song/x/1']) {
    const { client, interaction } = setup('links-default-' + link.length, {
      createConnection: () => makePlayer(null),
      resolve: async ({ query }) => ({ loadType: 'track', tracks: [track(query)] }),
    });
    const { embed } = await playQuery(client, interaction, link);
    assert.equal(embed.toJSON().title, 'Now playing');
  }
});

test('a link is opened on a node that can play it and the player is created there', async () => {
  const created = [];
  const nodeA = { name: 'A' };
  const nodeB = { name: 'B' };
  const { client, interaction } = setup('links-nodes', {
    leastUsedNodes: [nodeA, nodeB],
    createPlayer: (node) => { created.push(node.name); return makePlayer(node); },
    createConnection: () => { throw new Error('must use the node that opened the link'); },
    resolve: async ({ node }) => node.name === 'A'
      ? { loadType: 'empty', tracks: [] }
      : { loadType: 'track', tracks: [track('From B')] },
  });
  const { embed } = await playQuery(client, interaction, 'Check this out https://music.amazon.com/tracks/B0123');
  assert.deepEqual(created, ['B']);
  assert.equal(embed.toJSON().title, 'Now playing');
});

test('a link nobody can open gives a clear message and does not join voice', async () => {
  let joined = 0;
  const { client, interaction } = setup('links-none', {
    leastUsedNodes: [{ name: 'A' }, { name: 'B' }],
    createPlayer: () => { joined += 1; return makePlayer(null); },
    createConnection: () => { joined += 1; return makePlayer(null); },
    resolve: async () => ({ loadType: 'error', tracks: [], exception: { message: 'private' } }),
  });
  await assert.rejects(playQuery(client, interaction, 'https://open.spotify.com/playlist/private'), error => {
    assert.equal(error.name, 'CloudyError');
    assert.match(error.userMessage, /could not be opened/);
    return true;
  });
  assert.equal(joined, 0);
});

test('when every node is unreachable the music-server message is shown', async () => {
  const { client, interaction } = setup('links-down', {
    leastUsedNodes: [{ name: 'A' }],
    createPlayer: () => makePlayer(null),
    resolve: async () => { throw new TypeError('no body'); },
  });
  await assert.rejects(playQuery(client, interaction, 'https://youtu.be/dQw4w9WgXcQ'), error => {
    assert.equal(error.type, 'network');
    assert.match(error.userMessage, /music server is not responding/);
    return true;
  });
});
