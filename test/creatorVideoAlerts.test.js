import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import {
  configuredVideoSources, parseYoutubeUploadFeed, pollCreatorVideoAlerts,
} from '../src/services/creatorVideoAlertsService.js';

const GUILD = '1532882647838228723';
const ID = 'UC' + 'a'.repeat(22);
const channels = {
  youtube: '1554538629102309416',
  twitch: '1554538630129778702',
  tiktok: '1554538632323272755',
};

function makeFixture() {
  const store = new Map(), posts = [];
  const guild = { id: GUILD, channels: { cache: new Collection() } };
  const client = {
    guilds: { cache: new Collection([[GUILD, guild]]) },
    channels: { cache: new Collection() },
    db: {
      get: async (key, fallback = null) => store.has(key) ? structuredClone(store.get(key)) : fallback,
      set: async (key, value) => { store.set(key, structuredClone(value)); return true; },
    },
  };
  for (const [platform, id] of Object.entries(channels)) {
    const channel = {
      id, guildId: GUILD, guild,
      name: platform, isTextBased: () => true, isSendable: () => true,
      send: async payload => { posts.push({ platform, ...payload }); return { id: String(posts.length) }; },
    };
    guild.channels.cache.set(id, channel);
    client.channels.cache.set(id, channel);
  }
  return { client, posts, store };
}

function sourceMock() {
  let generation = 0;
  const calls = [];
  const feed = () => {
    const videos = generation === 0 ? ['abcdefghi12'] : ['abcdefghi34', 'abcdefghi12'];
    return '<?xml version="1.0"?><feed>' + videos.map((id, i) =>
      `<entry><yt:videoId>${id}</yt:videoId><published>2026-11-0${generation === 0 ? 6 : 7}T0${i}:00:00+00:00</published></entry>`).join('') + '</feed>';
  };
  const twitch = () => ({
    data: (generation === 0 ? ['900'] : ['901', '900']).map((id, i) => ({
      id, url: 'https://www.twitch.tv/videos/' + id,
      created_at: `2026-11-0${generation === 0 ? 6 : 7}T0${i}:00:00Z`,
    })),
  });
  const tiktok = () => ({
    data: { videos: (generation === 0 ? ['800'] : ['801', '800']).map((id, i) => ({
      id, share_url: 'https://www.tiktok.com/@cloudy/video/' + id,
      create_time: 1794096000 - i,
    })) },
    error: { code: 'ok', message: '' },
  });
  const getResponse = (url, options) => {
    calls.push({ url: String(url), method: options?.method || 'GET' });
    if (String(url).includes('youtube.com/feeds/videos.xml')) return { ok: true, text: async () => feed() };
    if (String(url).includes('id.twitch.tv/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-token' }) };
    if (String(url).includes('api.twitch.tv/helix/videos')) return { ok: true, json: async () => twitch() };
    if (String(url).includes('open.tiktokapis.com/v2/video/list')) return { ok: true, json: async () => tiktok() };
    throw new Error('Unexpected provider endpoint: ' + String(url));
  };
  return {
    setGeneration(next) { generation = next; },
    calls, fetchImpl: async (url, options) => getResponse(url, options),
  };
}

const env = {
  CLOUDY_YOUTUBE_CHANNEL_IDS: ID,
  CLOUDY_TWITCH_CLIENT_ID: 'test-client',
  CLOUDY_TWITCH_CLIENT_SECRET: 'test-secret',
  CLOUDY_TWITCH_USER_IDS: '123456',
  CLOUDY_TIKTOK_ACCESS_TOKEN: 'test-tiktok-token',
};

test('no configuration means no external requests or public posts', async () => {
  const f = makeFixture();
  const mock = sourceMock();
  assert.deepEqual(configuredVideoSources({}), []);
  assert.deepEqual(await pollCreatorVideoAlerts(f.client, { env: {}, fetchImpl: mock.fetchImpl }), {
    sources: 0, posted: 0,
  });
  assert.equal(f.posts.length, 0);
  assert.equal(mock.calls.length, 0);
});

test('sources require explicit creator IDs and OAuth credentials', () => {
  assert.deepEqual(configuredVideoSources({ CLOUDY_YOUTUBE_CHANNEL_IDS: 'invalid' }), []);
  const sources = configuredVideoSources(env);
  assert.deepEqual(sources.map(x=>x.platform), ['youtube', 'twitch', 'tiktok']);
  assert.deepEqual(sources.map(x=>x.accountId), [ID, '123456', 'authorized']);
});

test('YouTube feed extracts newest real official uploads only', () => {
  const xml = `<feed>
  <entry><yt:videoId>abcdefghi34</yt:videoId><published>2026-11-07T13:00:00Z</published></entry>
  <entry><yt:videoId>abcdefghi12</yt:videoId><published>2026-11-06T10:00:00Z</published></entry>
  </feed>`;
  const data = parseYoutubeUploadFeed(xml);
  assert.deepEqual(data.map(item=>item.url), [
    'https://www.youtube.com/watch?v=abcdefghi34',
    'https://www.youtube.com/watch?v=abcdefghi12',
  ]);
  assert.deepEqual(parseYoutubeUploadFeed('<feed>no videos</feed>'), []);
});

test('all three official providers baseline existing videos and publish only new links once', async () => {
  const f = makeFixture(), mock = sourceMock();
  const first = await pollCreatorVideoAlerts(f.client, { env, fetchImpl: mock.fetchImpl });
  assert.deepEqual(first, { sources: 3, posted: 0 });
  assert.equal(f.posts.length, 0, 'initial scan must not flood the server with old uploads');
  mock.setGeneration(1);
  const second = await pollCreatorVideoAlerts(f.client, { env, fetchImpl: mock.fetchImpl });
  assert.deepEqual(second, { sources: 3, posted: 3 });
  assert.deepEqual(f.posts.map(post=>[post.platform,post.content]), [
    ['youtube', 'https://www.youtube.com/watch?v=abcdefghi34'],
    ['twitch', 'https://www.twitch.tv/videos/901'],
    ['tiktok', 'https://www.tiktok.com/@cloudy/video/801'],
  ]);
  for (const post of f.posts) {
    assert.deepEqual(post.allowedMentions, { parse: [] });
    assert.ok(!post.embeds, 'no self-authored embed or unsolicited announcement text');
  }
  const third = await pollCreatorVideoAlerts(f.client, { env, fetchImpl: mock.fetchImpl });
  assert.deepEqual(third, { sources: 3, posted: 0 });
  assert.equal(f.posts.length, 3, 'poll after restart must be idempotent');
  assert.ok(mock.calls.some(x=>x.url.includes('helix/videos?user_id=123456')));
  assert.ok(mock.calls.some(x=>x.method==='POST'&&x.url.includes('video/list')));
});

test('a deliberately configured source stays silent when its channel is unavailable', async () => {
  const f = makeFixture(), mock = sourceMock();
  f.client.guilds.cache.get(GUILD).channels.cache.clear();
  f.client.channels.cache.clear();
  const result = await pollCreatorVideoAlerts(f.client, { env, fetchImpl: mock.fetchImpl });
  assert.deepEqual(result, { sources: 3, posted: 0 });
  assert.equal(mock.calls.length, 0);
});
