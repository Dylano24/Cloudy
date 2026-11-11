import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyCreatorInput, resolveCreatorAccount } from '../src/services/creatorLinkResolver.js';
import {
  addCreatorNotification, listCreatorNotifications, removeCreatorNotification,
} from '../src/services/creatorNotificationService.js';

const ID = 'UC1234567890123456789012';
const GUILD = '1520000000000000000';
const response = html => ({ ok: true, status: 200, text: async () => html });
const html = '<html><script>var metadata = {"externalId":"' + ID + '"};</script></html>';
function fakeClient() {
  const storage = new Map();
  return { db: {
    get: async key => structuredClone(storage.get(key) || null),
    set: async (key, value) => { storage.set(key, structuredClone(value)); return true; },
  } };
}

test('pasted YouTube UC channel links and IDs resolve locally without a network request', async () => {
  const noFetch = async () => { throw new Error('No request should be made'); };
  assert.equal(await resolveCreatorAccount('youtube', ID, { fetcher: noFetch }), ID);
  assert.equal(await resolveCreatorAccount('youtube',
    'https://www.youtube.com/channel/' + ID + '/videos?view=0', { fetcher: noFetch }), ID);
  assert.equal(await resolveCreatorAccount('youtube',
    'youtube.com/channel/' + ID + '?si=123', { fetcher: noFetch }), ID);
});

test('a pasted YouTube @handle or legacy custom link retrieves the real UC channel ID', async () => {
  const urls = [];
  const fetcher = async (url, options) => {
    urls.push({ url, options });
    return response(html);
  };
  for (const source of [
    'https://www.youtube.com/@CreatorExample?si=abc',
    'youtube.com/@CreatorExample/videos',
    '@CreatorExample',
    'https://m.youtube.com/@CreatorExample/shorts',
    'https://www.youtube.com/c/CreatorExample',
    'https://www.youtube.com/user/CreatorExample',
  ]) {
    assert.equal(await resolveCreatorAccount('youtube', source, { fetcher, env: {} }), ID, source);
  }
  assert.equal(urls.length, 6);
  assert.equal(urls[0].url, 'https://www.youtube.com/@CreatorExample');
  assert.equal(urls[0].options.redirect, 'manual');
  assert.ok(urls.every(entry => entry.url.startsWith('https://www.youtube.com/')),
    'fetch only allowlisted YouTube page URLs');
});

test('official YouTube API forHandle also resolves channel ID when configured', async () => {
  const urls = [];
  const fetcher = async url => {
    urls.push(url);
    return {
      ok: true, status: 200,
      json: async () => ({ items: [{ id: ID }] }),
    };
  };
  assert.equal(await resolveCreatorAccount('youtube', 'https://youtube.com/@CreatorExample', {
    fetcher, env: { YOUTUBE_API_KEY: 'test-key' },
  }), ID);
  assert.equal(urls.length, 1);
  const url = new URL(urls[0]);
  assert.equal(url.hostname, 'www.googleapis.com');
  assert.equal(url.searchParams.get('forHandle'), 'CreatorExample');
});

test('YouTube page fallback remains available if optional API is down', async () => {
  let calls = 0;
  const fetcher = async url => {
    calls++;
    if (url.startsWith('https://www.googleapis.com/')) throw new Error('API down');
    return response(html);
  };
  assert.equal(await resolveCreatorAccount('youtube', '@CreatorExample', {
    fetcher, env: { YOUTUBE_API_KEY: 'test-key' },
  }), ID);
  assert.equal(calls, 2);
});

test('channel-ID metadata tags and safe YouTube redirects are resolved', async () => {
  const fetcher = async url => url.includes('/@OldCreator') ? {
    status: 302, ok: false, headers: { get: () => '/@NewCreator' },
  } : response('<html><meta itemprop="channelId" content="' + ID + '"></html>');
  assert.equal(await resolveCreatorAccount('youtube', 'https://youtube.com/@OldCreator', {
    fetcher, env: {},
  }), ID);
});

test('YouTube rejects unrelated sites and unsafe redirects without accessing them', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return { status: 302, ok: false, headers: { get: () => 'https://example.com/private' } };
  };
  await assert.rejects(
    resolveCreatorAccount('youtube', 'https://youtube.com.evil.example/@CreatorExample', { fetcher }),
    /valid link/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    resolveCreatorAccount('youtube', 'https://youtube.com/@CreatorExample', { fetcher, env: {} }),
    /valid link/,
  );
  assert.equal(calls, 1);
});

test('Twitch and TikTok profile and video links use their creator usernames', async () => {
  const noFetch = async () => { throw new Error('No network request expected'); };
  assert.equal(await resolveCreatorAccount('twitch',
    'https://www.twitch.tv/Example_Name/videos?filter=archives', { fetcher: noFetch }), 'example_name');
  assert.equal(await resolveCreatorAccount('tiktok',
    'https://www.tiktok.com/@Example.Name/video/123?lang=en', { fetcher: noFetch }), 'example.name');
  assert.equal(await resolveCreatorAccount('tiktok',
    'https://m.tiktok.com/@Example.Name?lang=en', { fetcher: noFetch }), 'example.name');
  await assert.rejects(resolveCreatorAccount('twitch', 'https://www.twitch.tv/videos/123'), /profile link/);
  await assert.rejects(resolveCreatorAccount('tiktok',
    'https://www.tiktok.com.evil.example/@Example.Name'), /valid link/);
});

test('add and remove with the same YouTube channel link store stable UC IDs and deduplicate', async () => {
  const client = fakeClient();
  const profile = 'https://www.youtube.com/@CreatorExample';
  const fetcher = async () => response(html);
  const item = await addCreatorNotification(client, GUILD, 'youtube', profile, null, { fetcher, env: {} });
  assert.equal(item.account, ID);
  assert.equal(item.source, profile);
  await assert.rejects(addCreatorNotification(client, GUILD, 'youtube', ID, null), /already being monitored/);
  assert.equal((await listCreatorNotifications(client, GUILD)).length, 1);
  assert.equal(await removeCreatorNotification(client, GUILD, 'youtube', profile, {
    fetcher: async () => { throw new Error('The page is unavailable now'); },
  }), true, 'removal by original pasted link should not require another YouTube request');
  assert.equal((await listCreatorNotifications(client, GUILD)).length, 0);
});

test('common pasted YouTube share links resolve the author from video metadata', async () => {
  const videoId = 'dQw4w9WgXcQ';
  const videoPage = '<script>ytInitialPlayerResponse={"videoDetails":{"videoId":"' +
    videoId + '","channelId":"' + ID + '","title":"Clip"}};</script>';
  const urls = [];
  const fetcher = async url => {
    urls.push(url);
    return response(videoPage);
  };
  const sources = [
    'https://youtu.be/' + videoId + '?si=abc123',
    'youtu.be/' + videoId,
    'https://www.youtube.com/watch?v=' + videoId + '&si=xyz',
    'https://youtube.com/shorts/' + videoId + '?feature=share',
    'https://www.youtube.com/live/' + videoId,
    'https://music.youtube.com/watch?v=' + videoId,
  ];
  for (const source of sources) {
    assert.equal(await resolveCreatorAccount('youtube', source, { fetcher, env: {} }), ID, source);
  }
  assert.equal(urls.length, sources.length);
  assert.ok(urls.every(url => url === 'https://www.youtube.com/watch?v=' + videoId));
});

test('YouTube share URLs still reject untrusted hosts before fetching', async () => {
  let attempted = 0;
  const fetcher = async () => { attempted++; return response(''); };
  await assert.rejects(
    resolveCreatorAccount('youtube', 'https://youtu.be.attacker.example/dQw4w9WgXcQ', { fetcher }),
    /valid link/,
  );
  assert.equal(attempted, 0);
});

test('pasted profile links identify their platform regardless of Discord dropdown', async () => {
  assert.deepEqual(identifyCreatorInput('tiktok', 'https://youtube.com/@CreatorExample'), {
    platform: 'youtube', input: 'https://youtube.com/@CreatorExample',
  });
  assert.deepEqual(identifyCreatorInput('youtube', 'https://www.twitch.tv/Example_Name'), {
    platform: 'twitch', input: 'https://www.twitch.tv/Example_Name',
  });
  assert.deepEqual(identifyCreatorInput(null, 'https://www.tiktok.com/@Example.Name'), {
    platform: 'tiktok', input: 'https://www.tiktok.com/@Example.Name',
  });
  assert.deepEqual(identifyCreatorInput(null, ID), { platform: 'youtube', input: ID });
  assert.deepEqual(identifyCreatorInput(null,
    'Check out this creator: https://youtube.com/@CreatorExample?si=abc'),
  { platform: 'youtube', input: 'https://youtube.com/@CreatorExample?si=abc' });
  await assert.rejects(async () => identifyCreatorInput(null, '@ambiguoususer'),
    /select a platform/i);
  assert.throws(() => identifyCreatorInput('youtube', 'https://youtube.com.evil.example/@creator'),
    /Paste a YouTube, Twitch or TikTok creator link/);
});

test('adding a YouTube URL when TikTok is selected detects correct provider and can be removed', async () => {
  const client = fakeClient();
  const profile = 'https://www.youtube.com/@CreatorExample';
  const fetcher = async () => response(html);
  const added = await addCreatorNotification(client, GUILD, 'tiktok', profile, null, { fetcher, env: {} });
  assert.equal(added.platform, 'youtube');
  assert.equal(added.id, 'youtube:' + ID);
  assert.equal(added.account, ID);
  assert.equal((await listCreatorNotifications(client, GUILD))[0].platform, 'youtube');
  assert.equal(await removeCreatorNotification(client, GUILD, 'tiktok', profile), true);
  assert.equal((await listCreatorNotifications(client, GUILD)).length, 0);
});

test('Twitch and TikTok URLs require no platform selection and normalize profiles', async () => {
  const client = fakeClient();
  const twitch = await addCreatorNotification(client, GUILD, null, 'https://www.twitch.tv/Example_Name', null);
  const tiktok = await addCreatorNotification(client, GUILD, null, 'https://www.tiktok.com/@Example.Name', null);
  assert.equal(twitch.id, 'twitch:example_name');
  assert.equal(tiktok.id, 'tiktok:example.name');
  assert.equal((await listCreatorNotifications(client, GUILD)).length, 2);
});
