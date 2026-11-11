import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCreatorAccount } from '../src/services/creatorLinkResolver.js';
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
