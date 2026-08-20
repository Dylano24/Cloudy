import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';

const SUBSCRIPTION_KEY_PREFIX = 'youtube:subscriptions:';
const POLL_INTERVAL_MS = 5 * 60_000;
const YOUTUBE_CHANNEL_ID_RE = /^UC[a-zA-Z0-9_-]{22}$/;
const YOUTUBE_VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function subscriptionKey(guildId) {
  return `${SUBSCRIPTION_KEY_PREFIX}${guildId}`;
}

function xmlDecode(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function tagValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? xmlDecode(match[1].trim()) : null;
}

function attrValue(block, tag, attr) {
  const match = block.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]+)"[^>]*>`, 'i'));
  return match ? xmlDecode(match[1]) : null;
}

function extractVideoId(input) {
  const raw = String(input || '').trim();
  if (YOUTUBE_VIDEO_ID_RE.test(raw)) return raw;

  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    if (url.hostname.includes('youtu.be')) {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return YOUTUBE_VIDEO_ID_RE.test(id) ? id : null;
    }
    if (url.hostname.includes('youtube.com')) {
      const watchId = url.searchParams.get('v');
      if (YOUTUBE_VIDEO_ID_RE.test(watchId || '')) return watchId;
      const parts = url.pathname.split('/').filter(Boolean);
      const shortIndex = parts.findIndex((part) => ['shorts', 'live', 'embed'].includes(part));
      if (shortIndex !== -1 && YOUTUBE_VIDEO_ID_RE.test(parts[shortIndex + 1] || '')) {
        return parts[shortIndex + 1];
      }
    }
  } catch {
    return null;
  }

  return null;
}

function extractPlaylistId(input) {
  const raw = String(input || '').trim();
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return url.searchParams.get('list');
  } catch {
    return raw.length >= 10 ? raw : null;
  }
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 12_000);
  timeout.unref?.();

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'CloudyManager/1.0 (+Discord bot)',
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Remote service returned invalid JSON');
  }
}

export async function resolveYouTubeChannelId(input) {
  const raw = String(input || '').trim();
  if (YOUTUBE_CHANNEL_ID_RE.test(raw)) return raw;

  const directMatch = raw.match(/(?:youtube\.com\/channel\/)?(UC[a-zA-Z0-9_-]{22})/);
  if (directMatch) return directMatch[1];

  let pageUrl = raw;
  if (/^@[a-zA-Z0-9._-]+$/.test(raw)) {
    pageUrl = `https://www.youtube.com/${raw}`;
  } else if (!/^https?:\/\//i.test(raw)) {
    pageUrl = `https://www.youtube.com/@${raw.replace(/^@/, '')}`;
  }

  const html = await fetchText(pageUrl);
  const patterns = [
    /"channelId":"(UC[a-zA-Z0-9_-]{22})"/,
    /"externalId":"(UC[a-zA-Z0-9_-]{22})"/,
    /youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }

  throw new Error('Could not resolve that YouTube channel. Use a channel ID (UC...) or @handle.');
}

export async function fetchYouTubeFeed(channelId) {
  if (!YOUTUBE_CHANNEL_ID_RE.test(channelId)) {
    throw new Error('Invalid YouTube channel ID');
  }

  const xml = await fetchText(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
  );

  const feedTitle = tagValue(xml, 'title') || 'YouTube Channel';
  const channelUrl = attrValue(xml, 'link', 'href') || `https://www.youtube.com/channel/${channelId}`;
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);

  const videos = entries.map((entry) => {
    const videoId = tagValue(entry, 'yt:videoId');
    const title = tagValue(entry, 'title') || 'Untitled video';
    const published = tagValue(entry, 'published');
    const updated = tagValue(entry, 'updated');
    const authorBlock = entry.match(/<author>([\s\S]*?)<\/author>/i)?.[1] || '';
    const author = tagValue(authorBlock, 'name') || feedTitle;
    const description = tagValue(entry, 'media:description');

    return {
      id: videoId,
      title,
      published,
      updated,
      author,
      description,
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
      thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null,
    };
  }).filter((video) => video.id);

  return {
    channelId,
    title: feedTitle,
    url: channelUrl,
    videos,
  };
}

export async function getLatestYouTubeVideo(input) {
  const channelId = await resolveYouTubeChannelId(input);
  const feed = await fetchYouTubeFeed(channelId);
  return { channel: feed, video: feed.videos[0] || null };
}

export async function getYouTubeVideoInfo(input) {
  const videoId = extractVideoId(input);
  if (!videoId) throw new Error('Use a valid YouTube video URL or 11-character video ID.');

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const oembed = await fetchJson(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
  );

  return {
    id: videoId,
    url,
    title: oembed.title || 'YouTube Video',
    author: oembed.author_name || 'Unknown creator',
    authorUrl: oembed.author_url || null,
    thumbnail: oembed.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

async function youtubeApi(path, params = {}) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error('This YouTube feature needs YOUTUBE_API_KEY in Railway Variables. Upload alerts and latest-video do not need a key.');
  }

  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  url.searchParams.set('key', apiKey);

  const data = await fetchJson(url.toString());
  if (data.error) throw new Error(data.error.message || 'YouTube API request failed');
  return data;
}

export async function getYouTubeChannelInfo(input) {
  const channelId = await resolveYouTubeChannelId(input);
  const feed = await fetchYouTubeFeed(channelId);

  if (!process.env.YOUTUBE_API_KEY) {
    return {
      id: channelId,
      title: feed.title,
      url: feed.url,
      latestVideo: feed.videos[0] || null,
      statistics: null,
      description: null,
    };
  }

  const data = await youtubeApi('channels', {
    part: 'snippet,statistics',
    id: channelId,
  });
  const item = data.items?.[0];

  return {
    id: channelId,
    title: item?.snippet?.title || feed.title,
    url: `https://www.youtube.com/channel/${channelId}`,
    description: item?.snippet?.description || null,
    thumbnail: item?.snippet?.thumbnails?.high?.url || item?.snippet?.thumbnails?.default?.url || null,
    statistics: item?.statistics || null,
    latestVideo: feed.videos[0] || null,
  };
}

export async function getYouTubePlaylistInfo(input) {
  const playlistId = extractPlaylistId(input);
  if (!playlistId) throw new Error('Use a valid YouTube playlist URL or playlist ID.');

  const data = await youtubeApi('playlists', {
    part: 'snippet,contentDetails',
    id: playlistId,
  });
  const item = data.items?.[0];
  if (!item) throw new Error('Playlist not found or not public.');

  return {
    id: playlistId,
    url: `https://www.youtube.com/playlist?list=${playlistId}`,
    title: item.snippet?.title || 'YouTube Playlist',
    description: item.snippet?.description || null,
    creator: item.snippet?.channelTitle || 'Unknown creator',
    thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || null,
    itemCount: item.contentDetails?.itemCount ?? null,
  };
}

export async function getYouTubeTrending(regionCode = 'US') {
  const data = await youtubeApi('videos', {
    part: 'snippet,statistics',
    chart: 'mostPopular',
    regionCode: String(regionCode || 'US').toUpperCase(),
    maxResults: 10,
  });

  return (data.items || []).map((item) => ({
    id: item.id,
    title: item.snippet?.title || 'Untitled',
    channelTitle: item.snippet?.channelTitle || 'Unknown',
    url: `https://www.youtube.com/watch?v=${item.id}`,
    views: item.statistics?.viewCount || null,
  }));
}

export async function getRandomYouTubeVideo(query) {
  const search = await youtubeApi('search', {
    part: 'snippet',
    type: 'video',
    q: query,
    maxResults: 25,
    safeSearch: 'moderate',
  });

  const items = search.items || [];
  if (!items.length) throw new Error('No YouTube videos found for that search.');
  const item = items[Math.floor(Math.random() * items.length)];
  const videoId = item.id?.videoId;

  return {
    id: videoId,
    title: item.snippet?.title || 'YouTube Video',
    channelTitle: item.snippet?.channelTitle || 'Unknown creator',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || null,
  };
}

export async function getYouTubeSubscriptions(client, guildId) {
  const stored = await client.db?.get?.(subscriptionKey(guildId), []);
  return Array.isArray(stored) ? stored : [];
}

async function saveYouTubeSubscriptions(client, guildId, subscriptions) {
  await client.db?.set?.(subscriptionKey(guildId), subscriptions);
}

export async function addYouTubeSubscription(client, {
  guildId,
  youtubeChannel,
  discordChannelId,
  mentionRoleId = null,
}) {
  const channelId = await resolveYouTubeChannelId(youtubeChannel);
  const feed = await fetchYouTubeFeed(channelId);
  const subscriptions = await getYouTubeSubscriptions(client, guildId);
  const existingIndex = subscriptions.findIndex((entry) => entry.youtubeChannelId === channelId);

  const subscription = {
    youtubeChannelId: channelId,
    youtubeChannelTitle: feed.title,
    discordChannelId,
    mentionRoleId,
    lastVideoId: feed.videos[0]?.id || null,
    createdAt: new Date().toISOString(),
  };

  if (existingIndex >= 0) subscriptions[existingIndex] = subscription;
  else subscriptions.push(subscription);

  await saveYouTubeSubscriptions(client, guildId, subscriptions);
  return subscription;
}

export async function removeYouTubeSubscription(client, guildId, identifier) {
  const subscriptions = await getYouTubeSubscriptions(client, guildId);
  const normalized = String(identifier || '').trim().toLowerCase();
  let channelId = null;

  try {
    channelId = await resolveYouTubeChannelId(identifier);
  } catch {
    // Fall back to matching the stored channel title or raw ID.
  }

  const filtered = subscriptions.filter((entry) => {
    if (channelId && entry.youtubeChannelId === channelId) return false;
    if (entry.youtubeChannelId.toLowerCase() === normalized) return false;
    if (String(entry.youtubeChannelTitle || '').toLowerCase() === normalized) return false;
    return true;
  });

  if (filtered.length === subscriptions.length) return false;
  await saveYouTubeSubscriptions(client, guildId, filtered);
  return true;
}

function uploadEmbed(subscription, video) {
  return new EmbedBuilder()
    .setTitle(video.title)
    .setURL(video.url)
    .setAuthor({ name: subscription.youtubeChannelTitle || video.author || 'YouTube' })
    .setDescription(video.description?.slice(0, 1000) || 'A new YouTube video was uploaded.')
    .setThumbnail(video.thumbnail)
    .setTimestamp(video.published ? new Date(video.published) : new Date());
}

async function deliverSubscriptionUpdate(client, guild, subscription, video) {
  const channel = guild.channels.cache.get(subscription.discordChannelId)
    || await guild.channels.fetch(subscription.discordChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) return false;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Watch on YouTube')
      .setStyle(ButtonStyle.Link)
      .setURL(video.url),
  );

  await channel.send({
    content: subscription.mentionRoleId ? `<@&${subscription.mentionRoleId}> New YouTube upload!` : '📺 New YouTube upload!',
    embeds: [uploadEmbed(subscription, video)],
    components: [row],
    allowedMentions: subscription.mentionRoleId ? { roles: [subscription.mentionRoleId] } : { parse: [] },
  });
  return true;
}

async function pollGuildSubscriptions(client, guild) {
  const subscriptions = await getYouTubeSubscriptions(client, guild.id);
  if (!subscriptions.length) return;

  let changed = false;
  for (const subscription of subscriptions) {
    try {
      const feed = await fetchYouTubeFeed(subscription.youtubeChannelId);
      const latest = feed.videos[0];
      if (!latest || latest.id === subscription.lastVideoId) continue;

      const oldIndex = feed.videos.findIndex((video) => video.id === subscription.lastVideoId);
      const newVideos = oldIndex > 0
        ? feed.videos.slice(0, oldIndex).reverse()
        : [latest];

      for (const video of newVideos.slice(-5)) {
        await deliverSubscriptionUpdate(client, guild, subscription, video);
      }

      subscription.lastVideoId = latest.id;
      subscription.youtubeChannelTitle = feed.title || subscription.youtubeChannelTitle;
      changed = true;
    } catch (error) {
      logger.warn(
        `YouTube poll failed for ${subscription.youtubeChannelId} in ${guild.id}: ${error?.message || error}`
      );
    }
  }

  if (changed) await saveYouTubeSubscriptions(client, guild.id, subscriptions);
}

async function pollAllSubscriptions(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      await pollGuildSubscriptions(client, guild);
    } catch (error) {
      logger.warn(`YouTube subscription poll failed in ${guild.id}: ${error?.message || error}`);
    }
  }
}

export function startYouTubeSubscriptionMonitor(client) {
  if (client.youtubeSubscriptionInterval) return;

  void pollAllSubscriptions(client);
  client.youtubeSubscriptionInterval = setInterval(
    () => void pollAllSubscriptions(client),
    POLL_INTERVAL_MS,
  );
  client.youtubeSubscriptionInterval.unref?.();
  logger.info('YouTube upload monitor started');
}

export async function testYouTubeSubscription(client, guild, subscription) {
  const feed = await fetchYouTubeFeed(subscription.youtubeChannelId);
  const latest = feed.videos[0];
  if (!latest) throw new Error('No public videos found for that YouTube channel.');
  return deliverSubscriptionUpdate(client, guild, subscription, latest);
}
