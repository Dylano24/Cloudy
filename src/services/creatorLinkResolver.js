// Accept familiar creator profile links while keeping YouTube subscriptions
// keyed to its stable UC channel ID. No untrusted host is ever fetched.
import { normalizeCreatorAccount } from './creatorNotificationProviders.js';
import { logger } from '../utils/logger.js';

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv']);
const TIKTOK_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);
const HANDLENAME = /^[\p{L}\p{N}_.-]{2,45}$/u;
const NO_ID = 'YouTube requires a channel ID';

function urlFromInput(raw) {
  const value = String(raw || '').trim();
  if (value.length > 512) throw new Error('Creator link is too long.');
  if (/^https?:\/\//i.test(value)) return new URL(value);
  if (/^(?:(?:www\.|m\.|music\.)?youtube\.com|(?:www\.)?youtu\.be|(?:www\.)?twitch\.tv|(?:www\.)?tiktok\.com)\//i.test(value)) {
    return new URL('https://' + value);
  }
  return null;
}

function validateUrl(url, hosts) {
  if (!hosts.has(url.hostname.toLowerCase())
    || !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.port) {
    throw new Error('Use a valid link from the selected platform.');
  }
}

// Discord's platform selector is optional when a supported link is pasted.
// Infer the provider from the verified hostname rather than rejecting a
// legitimate YouTube link because TikTok/Twitch was selected accidentally.
export function identifyCreatorInput(selectedPlatform, raw) {
  const rawText = String(raw || '').trim();
  if (rawText.length > 2048) throw new Error('Creator link is too long.');
  // Mobile share sheets can paste a line of text followed by the actual URL.
  const embedded = /(?:^|[\s(<])((?:https?:\/\/)?(?:(?:www\.|m\.|music\.)?youtube\.com|(?:www\.)?youtu\.be|(?:www\.)?twitch\.tv|(?:www\.|m\.)?tiktok\.com)\/[^\s<>]+)/i.exec(rawText);
  const input = (embedded?.[1] || rawText).replace(/^<|>$/g, '').replace(/[),;!?]+$/g, '');
  const url = urlFromInput(input);
  if (url) {
    const hostname = url.hostname.toLowerCase();
    const platform = YOUTUBE_HOSTS.has(hostname) ? 'youtube'
      : TWITCH_HOSTS.has(hostname) ? 'twitch'
        : TIKTOK_HOSTS.has(hostname) ? 'tiktok' : null;
    if (!platform) throw new Error('Paste a YouTube, Twitch or TikTok creator link.');
    validateUrl(url, platform === 'youtube' ? YOUTUBE_HOSTS
      : platform === 'twitch' ? TWITCH_HOSTS : TIKTOK_HOSTS);
    return { platform, input };
  }
  if (CHANNEL_ID.test(input)) return { platform: 'youtube', input };
  if (!['youtube', 'twitch', 'tiktok'].includes(selectedPlatform)) {
    throw new Error('Paste a creator profile link or select a platform for usernames.');
  }
  return { platform: selectedPlatform, input };
}

function youtubeReference(raw) {
  const input = String(raw || '').trim();
  if (CHANNEL_ID.test(input)) return { id: input };
  const url = urlFromInput(input);
  if (!url && /^@[\p{L}\p{N}_.-]{2,45}$/u.test(input)) {
    return { page: 'https://www.youtube.com/' + encodeURI(input), kind: 'handle', name: input.slice(1) };
  }
  if (!url) throw new Error(NO_ID);
  validateUrl(url, YOUTUBE_HOSTS);
  let parts;
  try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { throw new Error(NO_ID); }
  if (parts.length >= 2 && parts[0] === 'channel' && CHANNEL_ID.test(parts[1])) {
    return { id: parts[1] };
  }
  const first = parts[0] || '';
  // YouTube's share menu most often copies youtu.be, Shorts, Live or watch
  // links, not a profile URL. Resolve their author channel from the video.
  const videoId = url.hostname.endsWith('youtu.be') ? first
    : first === 'watch' ? url.searchParams.get('v')
      : ['shorts', 'live', 'embed'].includes(first) ? parts[1] : null;
  if (videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return { page: 'https://www.youtube.com/watch?v=' + videoId, kind: 'video', name: videoId };
  }
  if (first.startsWith('@') && HANDLENAME.test(first.slice(1))) {
    return { page: 'https://www.youtube.com/' + encodeURI(first), kind: 'handle', name: first.slice(1) };
  }
  if (['user', 'c'].includes(first) && HANDLENAME.test(parts[1] || '')) {
    return {
      page: 'https://www.youtube.com/' + first + '/' + encodeURIComponent(parts[1]),
      kind: first, name: parts[1],
    };
  }
  throw new Error(NO_ID);
}

function officialYouTubeId(html) {
  const id = '(UC[A-Za-z0-9_-]{22})';
  const patterns = [
    // Video shares expose the publishing channel in videoDetails rather than
    // the channelMetadataRenderer used on profile pages.
    new RegExp('"videoDetails"\\s*:\\s*\\{[\\s\\S]{0,5000}?"channelId"\\s*:\\s*"' + id + '"'),
    new RegExp('"externalId"\\s*:\\s*"' + id + '"'),
    new RegExp('"channelMetadataRenderer"\\s*:\\s*\\{[\\s\\S]{0,2000}?"externalId"\\s*:\\s*"' + id + '"'),
    new RegExp('feeds/videos\\.xml\\?channel_id=' + id),
    new RegExp('<link\\b[^>]*rel=["\\x27]canonical["\\x27][^>]*href=["\\x27]https://(?:www\\.)?youtube\\.com/channel/' + id + '["\\x27]', 'i'),
  ];
  for (const pattern of patterns) {
    const result = pattern.exec(html);
    if (result) return result[1];
  }
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (!/\bitemprop=["']channelId["']/i.test(tag)) continue;
    const match = new RegExp('\\bcontent=["\\x27]' + id + '["\\x27]', 'i').exec(tag);
    if (match) return match[1];
  }
  return null;
}

// Servers in the EU are sent to YouTube's cookie-consent page instead of the
// channel page. That is not a bad link, so it must never be reported as one.
const CONSENT_HOSTS = new Set(['consent.youtube.com', 'consent.google.com']);
const PAGE_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Cookie: 'SOCS=CAI; CONSENT=YES+cb',
};
class YouTubeConsentError extends Error {}

async function fetchYouTubePage(page, fetcher) {
  let current = page;
  for (let index = 0; index < 4; index++) {
    const response = await fetcher(current, {
      redirect: 'manual',
      headers: PAGE_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers?.get?.('location')) {
      const next = new URL(response.headers.get('location'), current);
      if (CONSENT_HOSTS.has(next.hostname.toLowerCase())
        || (next.hostname.toLowerCase() === 'www.google.com' && next.pathname.startsWith('/sorry'))) {
        throw new YouTubeConsentError('blocked');
      }
      if (!YOUTUBE_HOSTS.has(next.hostname.toLowerCase()) || next.protocol !== 'https:' || next.username || next.password || next.port) {
        throw new Error('YouTube returned an unsafe redirect.');
      }
      current = next.href;
      continue;
    }
    if (!response.ok) throw new Error('YouTube could not be reached (HTTP ' + response.status + ').');
    const html = await response.text();
    if (html.length > 5_000_000) throw new Error('YouTube returned an oversized response.');
    return officialYouTubeId(html);
  }
  throw new Error('YouTube redirected too many times.');
}

async function youtubeApiId({ kind, name }, env, fetcher) {
  const key = String(env.YOUTUBE_API_KEY || '').trim();
  if (!key || kind === 'c') return null;
  if (kind === 'video') {
    const video = new URLSearchParams({ part: 'snippet', key, id: name });
    const reply = await fetcher('https://www.googleapis.com/youtube/v3/videos?' + video, { signal: AbortSignal.timeout(10_000) });
    if (!reply.ok) return null;
    const channel = (await reply.json()).items?.[0]?.snippet?.channelId;
    return CHANNEL_ID.test(channel || '') ? channel : null;
  }
  const params = new URLSearchParams({ part: 'id', key, [kind === 'user' ? 'forUsername' : 'forHandle']: name });
  const response = await fetcher('https://www.googleapis.com/youtube/v3/channels?' + params, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const data = await response.json();
  const id = data.items?.[0]?.id;
  return CHANNEL_ID.test(id || '') ? id : null;
}

export async function resolveCreatorAccount(platform, raw, { fetcher = fetch, env = process.env } = {}) {
  if (platform !== 'youtube') {
    const input = String(raw || '').trim();
    const url = urlFromInput(input);
    if (!url) return normalizeCreatorAccount(platform, input);
    const hosts = platform === 'twitch' ? TWITCH_HOSTS : TIKTOK_HOSTS;
    validateUrl(url, hosts);
    let segments;
    try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
    catch { throw new Error('Enter a valid ' + platform + ' profile link.'); }
    if (platform === 'twitch' && ['videos', 'directory', 'search', 'settings', 'downloads'].includes(segments[0]?.toLowerCase())) {
      throw new Error('Enter a Twitch creator profile link.');
    }
    return normalizeCreatorAccount(platform, segments[0] || '');
  }

  const reference = youtubeReference(raw);
  if (reference.id) return reference.id;
  // Prefer the official API when configured; the public channel page works
  // without a key, so normal creator links need no extra service setup.
  // An API outage must not prevent the public page fallback.
  const id = await youtubeApiId(reference, env, fetcher).catch(() => null);
  if (id) return id;
  if (reference.kind === 'video') {
    // oEmbed names the video's creator profile; the video itself is never stored.
    try {
      const reply = await fetcher('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(reference.page), {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      });
      const author = reply.ok ? (await reply.json()).author_url : null;
      if (typeof author === 'string' && author !== reference.page) {
        return await resolveCreatorAccount('youtube', author, { fetcher, env });
      }
    } catch { /* fall back to the video page below */ }
  }
  const pages = [reference.page, reference.page.replace('//www.youtube.com/', '//m.youtube.com/')];
  let failure = null;
  for (const page of pages) {
    try {
      const pageId = await fetchYouTubePage(page, fetcher);
      if (pageId) return pageId;
    } catch (error) {
      failure = failure || error;
      if (/unsafe redirect|oversized response/i.test(error.message)) throw error;
    }
  }
  if (failure) logger.warn('[CREATOR_NOTIFY] YouTube lookup failed for ' + reference.page + ': ' + failure.message);
  if (failure instanceof YouTubeConsentError) {
    throw new Error('YouTube blocked the lookup from this server. Paste the channel link in the form youtube.com/channel/UC... or ask the operator to set YOUTUBE_API_KEY.');
  }
  if (failure) throw new Error('Could not reach YouTube to resolve this link. Try again in a moment.');
  throw new Error('Could not find a YouTube channel for this link.');
}
