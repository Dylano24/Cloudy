// Public YouTube Atom, Twitch Helix, and operator-provided TikTok RSS bridge.
// No TikTok scraping or unofficial credentials stored inside Cloudy.
export const CREATOR_PLATFORMS = ['youtube', 'twitch', 'tiktok'];
let twitchToken;

export function normalizeCreatorAccount(platform, raw) {
  const kind = String(platform || '').toLowerCase();
  if (!CREATOR_PLATFORMS.includes(kind)) throw new Error('Choose YouTube, Twitch or TikTok.');
  let account = String(raw || '').trim();
  if (kind === 'youtube') {
    account = account.replace(/^https:\/\/(?:www\.)?youtube\.com\/channel\//i, '').replace(/\/$/, '');
    if (!/^UC[\w-]{22}$/.test(account)) throw new Error('YouTube requires a channel ID');
  } else {
    account = account.replace(kind === 'twitch' ? /^https:\/\/(?:www\.)?twitch\.tv\//i : /^https:\/\/(?:www\.)?tiktok\.com\/@/i, '')
      .replace(/^@/, '').replace(/\/$/, '').toLowerCase();
    const valid = kind === 'twitch' ? /^[a-z0-9_]{3,25}$/ : /^[a-z0-9_.]{2,24}$/;
    if (!valid.test(account)) throw new Error('Invalid ' + kind + ' username.');
  }
  return account;
}

export function creatorProviderReady(platform, env = process.env) {
  if (platform === 'youtube') return true;
  if (platform === 'twitch') return Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET);
  if (platform !== 'tiktok') return false;
  try {
    const template = env.CREATOR_TIKTOK_FEED_TEMPLATE || '';
    return template.includes('{account}')
      && new URL(template.replace('{account}', 'creator')).protocol === 'https:';
  } catch { return false; }
}

function decodeXml(text) {
  return String(text || '').replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function xmlTag(body, tag) {
  const match = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(body);
  return decodeXml(match?.[1] || '').trim();
}
function safePlatformUrl(platform, raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    const hosts = {
      youtube: ['youtube.com', 'www.youtube.com', 'youtu.be'],
      tiktok: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
      twitch: ['twitch.tv', 'www.twitch.tv'],
    };
    return hosts[platform]?.includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

// A picture link of the platform's own host (never an arbitrary address).
function safeImageUrl(raw, hosts) {
  try {
    const url = new URL(String(raw || '').replace('%{width}', '1280').replace('%{height}', '720')
      .replace('{width}', '1280').replace('{height}', '720'));
    return url.protocol === 'https:' && hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : null;
  } catch { return null; }
}
const IMAGE_HOSTS = {
  youtube: ['ytimg.com', 'youtube.com'],
  twitch: ['twitch.tv', 'ttvnw.net', 'jtvnw.net'],
  tiktok: ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktok.com'],
};

export function parseCreatorFeed(xml, platform, account) {
  return [...String(xml || '').matchAll(/<(entry|item)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map(([, kind, body]) => {
      const videoId = xmlTag(body, 'yt:videoId');
      const alternate = /<link\b[^>]*href=["']([^"']+)["']/i.exec(body)?.[1];
      const link = videoId ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId)
        : (kind.toLowerCase() === 'entry' ? alternate : xmlTag(body, 'link')) || alternate;
      const url = safePlatformUrl(platform, link);
      const id = videoId || xmlTag(body, 'guid') || xmlTag(body, 'id') || url;
      if (!url || !id) return null;
      return {
        id: String(id).slice(0, 300),
        title: (xmlTag(body, 'title') || account + ' published a video').slice(0, 240),
        url,
        type: 'video',
        // The channel's name and the video's picture, for the announcement.
        author: (xmlTag(/<author\b[\s\S]*?<\/author>/i.exec(body)?.[0] || '', 'name') || '').slice(0, 100) || null,
        thumbnail: safeImageUrl(/<media:thumbnail\b[^>]*url=["']([^"']+)["']/i.exec(body)?.[1]
          || /<enclosure\b[^>]*url=["']([^"']+)["'][^>]*type=["']image/i.exec(body)?.[1]
          || (videoId ? 'https://i.ytimg.com/vi/' + encodeURIComponent(videoId) + '/hqdefault.jpg' : null), IMAGE_HOSTS[platform] || []),
        published: Date.parse(xmlTag(body, 'published') || xmlTag(body, 'pubDate') || xmlTag(body, 'updated')) || Date.now(),
      };
    }).filter(Boolean).slice(0, 12);
}

async function request(url, options, fetcher) {
  const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Provider returned HTTP ' + response.status);
  return response;
}

async function twitchAccess(env, fetcher) {
  if (twitchToken?.clientId === env.TWITCH_CLIENT_ID && twitchToken.expiresAt > Date.now() + 120_000) return twitchToken.value;
  const params = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });
  const data = await (await request('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  }, fetcher)).json();
  if (!data.access_token) throw new Error('Twitch authentication failed.');
  twitchToken = {
    value: data.access_token,
    clientId: env.TWITCH_CLIENT_ID,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  return twitchToken.value;
}

export async function fetchCreatorItems({ platform, account }, { env = process.env, fetcher = fetch } = {}) {
  if (!creatorProviderReady(platform, env)) {
    throw new Error(platform === 'tiktok'
      ? 'TikTok feed unavailable: configure CREATOR_TIKTOK_FEED_TEMPLATE.'
      : 'Twitch API unavailable: configure TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET.');
  }
  if (platform !== 'twitch') {
    const url = platform === 'youtube'
      ? 'https://www.youtube.com/feeds/videos.xml?channel_id=' + encodeURIComponent(account)
      : env.CREATOR_TIKTOK_FEED_TEMPLATE.replace('{account}', encodeURIComponent(account));
    return parseCreatorFeed(await (await request(url, {}, fetcher)).text(), platform, account);
  }
  const token = await twitchAccess(env, fetcher);
  const options = { headers: { 'Client-ID': env.TWITCH_CLIENT_ID, Authorization: 'Bearer ' + token } };
  const user = await (await request('https://api.twitch.tv/helix/users?login=' + encodeURIComponent(account), options, fetcher)).json();
  const id = user.data?.[0]?.id;
  if (!id) throw new Error('Unknown Twitch creator.');
  const [streams, videos] = await Promise.all([
    request('https://api.twitch.tv/helix/streams?user_id=' + id, options, fetcher).then(r => r.json()),
    request('https://api.twitch.tv/helix/videos?user_id=' + id + '&first=10&sort=time', options, fetcher).then(r => r.json()),
  ]);
  return [
    ...(streams.data || []).map(item => ({
      id: 'live:' + item.id, type: 'live',
      url: 'https://www.twitch.tv/' + account,
      title: item.title || account + ' is live',
      author: item.user_name || null,
      thumbnail: safeImageUrl(item.thumbnail_url, IMAGE_HOSTS.twitch),
      published: Date.parse(item.started_at) || Date.now(),
    })),
    ...(videos.data || []).map(item => ({
      id: 'video:' + item.id, type: 'video',
      url: item.url, title: item.title || account + ' uploaded a video',
      author: item.user_name || null,
      thumbnail: safeImageUrl(item.thumbnail_url, IMAGE_HOSTS.twitch),
      published: Date.parse(item.published_at) || Date.now(),
    })),
  ].filter(item => safePlatformUrl('twitch', item.url))
    .sort((a, b) => b.published - a.published).slice(0, 12);
}
