import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import { resolveCloudyChannel } from './cloudyChannelResolver.js';

const GUILD_ID = '1532882647838228723';
const POLL_INTERVAL = 5 * 60_000;
const KEY_PREFIX = 'cloudy:creator-video-alert:v1:';
const YOUTUBE_ID = /^UC[A-Za-z0-9_-]{22}$/;
const TWITCH_ID = /^\d{1,20}$/;
const failureLogs = new Map();

export const CREATOR_VIDEO_POLL_INTERVAL_MS = POLL_INTERVAL;

function officialVideoUrl(platform, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (platform === 'youtube' && ['www.youtube.com', 'youtube.com', 'youtu.be'].includes(host)) return url.href;
    if (platform === 'twitch' && ['www.twitch.tv', 'twitch.tv'].includes(host)) return url.href;
    if (platform === 'tiktok' && ['www.tiktok.com', 'tiktok.com', 'vm.tiktok.com'].includes(host)) return url.href;
  } catch { /* not an official link */ }
  return null;
}

function sortedUnique(entries) {
  const ids = new Set();
  return entries.filter(entry => {
    if (!entry?.id || !entry.url || ids.has(entry.id)) return false;
    ids.add(entry.id);
    return true;
  }).sort((a, b) => b.publishedAt - a.publishedAt);
}

export function parseYoutubeUploadFeed(xml) {
  const entries = String(xml || '').match(/<entry\b[^>]*>[\s\S]*?<\/entry>/g) || [];
  return sortedUnique(entries.map(entry => {
    const id = /<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/.exec(entry)?.[1];
    const time = /<published>([^<]+)<\/published>/.exec(entry)?.[1];
    return id ? {
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      publishedAt: Date.parse(time) || 0,
    } : null;
  }).filter(Boolean));
}

function parseTwitchVideos(payload) {
  return sortedUnique((payload?.data || []).map(video => ({
    id: String(video.id || ''),
    url: officialVideoUrl('twitch', video.url),
    publishedAt: Date.parse(video.published_at || video.created_at) || 0,
  })));
}

function parseTikTokVideos(payload) {
  return sortedUnique((payload?.data?.videos || []).map(video => ({
    id: String(video.id || ''),
    url: officialVideoUrl('tiktok', video.share_url || video.embed_link),
    publishedAt: Number(video.create_time) * 1000 || 0,
  })));
}

function parseIdentifiers(value, regex) {
  return [...new Set(String(value || '').split(',')
    .map(x => x.trim()).filter(x => regex.test(x)))].slice(0, 10);
}

export function configuredVideoSources(env = process.env) {
  const configs = [];
  for (const id of parseIdentifiers(env.CLOUDY_YOUTUBE_CHANNEL_IDS, YOUTUBE_ID)) {
    configs.push({ platform: 'youtube', accountId: id });
  }
  if (env.CLOUDY_TWITCH_CLIENT_ID && env.CLOUDY_TWITCH_CLIENT_SECRET) {
    for (const id of parseIdentifiers(env.CLOUDY_TWITCH_USER_IDS, TWITCH_ID)) {
      configs.push({ platform: 'twitch', accountId: id });
    }
  }
  if (env.CLOUDY_TIKTOK_ACCESS_TOKEN) {
    configs.push({ platform: 'tiktok', accountId: 'authorized' });
  }
  return configs;
}

async function requestJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error('Media provider HTTP ' + response.status);
  return response.json();
}

async function fetchUploads(fetchImpl, source, env) {
  switch (source.platform) {
    case 'youtube': {
      const uri = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + source.accountId;
      const response = await fetchImpl(uri, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error('YouTube feed HTTP ' + response.status);
      return parseYoutubeUploadFeed(await response.text());
    }
    case 'twitch': {
      const token = await requestJson(fetchImpl, 'https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.CLOUDY_TWITCH_CLIENT_ID,
          client_secret: env.CLOUDY_TWITCH_CLIENT_SECRET,
          grant_type: 'client_credentials',
        }).toString(),
      });
      if (!token.access_token) throw new Error('Twitch authentication unavailable');
      const uri = 'https://api.twitch.tv/helix/videos?user_id='
        + source.accountId + '&first=20&type=all';
      return parseTwitchVideos(await requestJson(fetchImpl, uri, {
        headers: {
          Authorization: 'Bearer ' + token.access_token,
          'Client-Id': env.CLOUDY_TWITCH_CLIENT_ID,
        },
      }));
    }
    case 'tiktok': {
      const data = await requestJson(fetchImpl,
        'https://open.tiktokapis.com/v2/video/list/?fields=id,share_url,create_time', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + env.CLOUDY_TIKTOK_ACCESS_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ max_count: 20 }),
        });
      if (data?.error?.code && data.error.code !== 'ok') throw new Error('TikTok authorization unavailable');
      return parseTikTokVideos(data);
    }
    default:
      return [];
  }
}

async function channelFor(client, guild, platform) {
  const channel = await resolveCloudyChannel(client, platform, { guild, textOnly: true });
  return channel?.isSendable?.() ? channel : null;
}

async function pollOneSource(client, guild, source, fetchImpl, env) {
  const id = `${source.platform}:${source.accountId}`;
  return Mutex.runExclusive(KEY_PREFIX + guild.id + ':' + id, async () => {
    // Do not start any external polling unless the designated channel exists.
    const channel = await channelFor(client, guild, source.platform);
    if (!channel || !client.db?.get || !client.db?.set) return { status: 'unavailable' };
    const items = await fetchUploads(fetchImpl, source, env);
    if (!items.length) return { status: 'empty' };

    const lastKey = KEY_PREFIX + guild.id + ':' + id + ':latest';
    const last = await client.db.get(lastKey, null);
    if (!last?.id) {
      // First observation only sets a baseline. Never dump old videos.
      if (await client.db.set(lastKey, { id: items[0].id }) === false) throw new Error('Could not save video baseline');
      return { status: 'initialized', published: 0 };
    }

    const previousIndex = items.findIndex(video => video.id === last.id);
    const fresh = previousIndex >= 0 ? items.slice(0, previousIndex) : items;
    let published = 0;
    for (const item of fresh.reverse()) {
      const claimKey = KEY_PREFIX + guild.id + ':' + id + ':posted:' + item.id;
      if (await client.db.get(claimKey, null)) continue;
      // Persist an at-most-once marker *before* Discord. A crash after send
      // must never create duplicate notifications.
      if (await client.db.set(claimKey, { state: 'posting', at: Date.now() }) === false) {
        throw new Error('Could not save video posting marker');
      }
      await channel.send({ content: item.url, allowedMentions: { parse: [] } });
      published++;
      await client.db.set(claimKey, { state: 'posted', at: Date.now() });
    }
    if (await client.db.set(lastKey, { id: items[0].id }) === false) throw new Error('Could not save latest video');
    return { status: published ? 'published' : 'current', published };
  });
}

function warnRateLimited(id, error) {
  const now = Date.now();
  if (now - (failureLogs.get(id) || 0) < 60 * 60_000) return;
  failureLogs.set(id, now);
  // Avoid logging API response bodies, bearer tokens, or external account names.
  logger.warn(`[VIDEO_ALERTS] ${id.split(':')[0]} notifications unavailable:`, error?.message);
}

export async function pollCreatorVideoAlerts(client, { env = process.env, fetchImpl = fetch } = {}) {
  const guild = client.guilds?.cache?.get(GUILD_ID);
  if (!guild) return { sources: 0, posted: 0 };
  const sources = configuredVideoSources(env);
  let posted = 0;
  for (const source of sources) {
    try {
      const result = await pollOneSource(client, guild, source, fetchImpl, env);
      posted += result.published || 0;
    } catch (error) {
      warnRateLimited(source.platform + ':' + source.accountId, error);
    }
  }
  return { sources: sources.length, posted };
}
