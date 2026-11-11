import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMusicLink, expandShortLink, prepareMusicQuery, getSpotifyTrackMetadata } from '../src/services/music/musicLinks.js';
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


test('Spotify track metadata is fetched from the official oEmbed endpoint without sharing tokens', async () => {
  let requested;
  const metadata = await getSpotifyTrackMetadata(
    'https://open.spotify.com/track/1ApUYfDejOBvrTnar2Wyf3?si=abc&context=playlist',
    { fetcher: async (url, options) => {
      requested = url;
      assert.ok(options.signal);
      return { ok: true, json: async () => ({ title: 'Real track title', thumbnail_url: 'https://i.scdn.co/image/cover' }) };
    } },
  );
  assert.equal(requested, 'https://open.spotify.com/oembed?url=https%3A%2F%2Fopen.spotify.com%2Ftrack%2F1ApUYfDejOBvrTnar2Wyf3');
  assert.deepEqual(metadata, { title: 'Real track title', artworkUrl: 'https://i.scdn.co/image/cover' });
  assert.equal(await getSpotifyTrackMetadata('https://evil.example/track/1ApUYfDejOBvrTnar2Wyf3'), null);
  assert.equal(await getSpotifyTrackMetadata('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), null);
});

test('a Spotify track rejected by Lavalink searches the actual title and retains its album cover', async t => {
  const link = 'https://open.spotify.com/track/1ApUYfDejOBvrTnar2Wyf3?si=abc';
  const calls = [];
  const { client, interaction } = setup('spotify-link-oembed', {
    leastUsedNodes: [{ name: 'Cloudy Private' }],
    createPlayer: node => makePlayer(node),
    resolve: async ({ query, source }) => {
      calls.push({ query, source });
      return { loadType: 'search', tracks: [track('Matching audio')] };
    },
  });
  t.mock.method(globalThis, 'fetch', async url => {
    assert.match(String(url), /^https:\/\/open\.spotify\.com\/oembed\?/);
    return { ok: true, json: async () => ({ title: 'Exact song', thumbnail_url: 'https://i.scdn.co/image/real-cover' }) };
  });
  const { embed } = await playQuery(client, interaction, link);
  assert.deepEqual(calls, [{ query: 'Exact song', source: 'scsearch' }]);
  assert.equal(embed.toJSON().image.url, 'https://i.scdn.co/image/real-cover');
  assert.equal(embed.toJSON().title, 'Now playing');
});

test('Spotify metadata unavailable retains the genuine music-server error without playing random songs', async t => {
  const { client, interaction } = setup('spotify-no-metadata', {
    leastUsedNodes: [{ name: 'Cloudy Private' }],
    createPlayer: () => { throw new Error('should not join voice'); },
    resolve: async () => ({ loadType: 'error', tracks: [], exception: { message: 'No Spotify source' } }),
  });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false }));
  await assert.rejects(playQuery(client, interaction,
    'https://open.spotify.com/track/1ApUYfDejOBvrTnar2Wyf3'),
  error => /link could not be opened/i.test(error.userMessage));
});


test('Spotify chooses SoundCloud first and falls back to music search if unavailable', async t => {
  const tried = [];
  const { client, interaction } = setup('spotify-soundcloud-fallback', {
    leastUsedNodes: [{ name: 'Cloudy Private' }],
    createPlayer: node => makePlayer(node),
    resolve: async ({ query, source }) => {
      tried.push({ query, source });
      if (source === 'scsearch') return { loadType: 'empty', tracks: [] };
      return { loadType: 'search', tracks: [track('Fallback audio')] };
    },
  });
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, json: async () => ({ title: 'Exact song', thumbnail_url: 'https://i.scdn.co/image/real-cover' }),
  }));
  const { embed } = await playQuery(client, interaction,
    'https://open.spotify.com/track/1ApUYfDejOBvrTnar2Wyf3');
  assert.deepEqual(tried, [
    { query: 'Exact song', source: 'scsearch' },
    { query: 'Exact song official audio', source: undefined },
  ]);
  assert.equal(embed.toJSON().image.url, 'https://i.scdn.co/image/real-cover');
});
