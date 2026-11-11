// Pasted music links. Cloudy hands every link to the music server, which opens
// YouTube, YouTube Music, Spotify, Apple Music, Deezer, SoundCloud and more.
// This module only cleans the pasted text (share messages, Spotify URIs, old
// iTunes links) and expands a few official short links.

const SPOTIFY_URI = /^spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]+)$/i;
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/i;
const SHORT_LINK_HOSTS = new Set(['spotify.link', 'spoti.fi', 'on.soundcloud.com', 'dzr.page.link', 'link.deezer.com']);
const EXPANDED_HOSTS = /^(?:open\.spotify\.com|(?:www\.)?soundcloud\.com|(?:www\.)?deezer\.com|music\.apple\.com|(?:www\.|m\.|music\.)?youtube\.com|youtu\.be)$/i;
const SHORT_LINK_TIMEOUT_MS = 4000;

// Returns a clean https link found in the pasted text, or null for a song name.
export function extractMusicLink(raw) {
  const text = String(raw ?? '').trim().replace(/^<|>$/g, '');
  if (!text) return null;
  const uri = SPOTIFY_URI.exec(text);
  if (uri) return 'https://open.spotify.com/' + uri[1].toLowerCase() + '/' + uri[2];
  const found = URL_IN_TEXT.exec(text);
  if (!found) return null;
  try {
    const url = new URL(found[0].replace(/[)\].,;!?]+$/, ''));
    const host = url.hostname.toLowerCase();
    // Old iTunes links open the same Apple Music page.
    if (host === 'itunes.apple.com' || host === 'geo.music.apple.com') url.hostname = 'music.apple.com';
    return url.href;
  } catch {
    return null;
  }
}

// Only known short-link hosts are fetched, and only redirects to music hosts are followed.
export async function expandShortLink(link, fetcher = fetch) {
  try {
    let current = link;
    for (let hop = 0; hop < 3; hop += 1) {
      const parsed = new URL(current);
      if (!SHORT_LINK_HOSTS.has(parsed.hostname.toLowerCase())) return current;
      const response = await fetcher(current, { redirect: 'manual', signal: AbortSignal.timeout(SHORT_LINK_TIMEOUT_MS) });
      const location = response?.headers?.get?.('location');
      if (!(response?.status >= 300 && response.status < 400) || !location) return current;
      const target = new URL(location, current);
      const host = target.hostname.toLowerCase();
      if (target.protocol !== 'https:' || (!SHORT_LINK_HOSTS.has(host) && !EXPANDED_HOSTS.test(host))) return current;
      current = target.href;
    }
    return current;
  } catch {
    return link;
  }
}

export async function prepareMusicQuery(raw, { fetcher = fetch } = {}) {
  const link = extractMusicLink(raw);
  if (!link) return { query: String(raw ?? '').trim(), isLink: false };
  return { query: await expandShortLink(link, fetcher), isLink: true };
}


// Lavalink's YouTube source cannot decode a Spotify track URL on its own.
// Spotify's public oEmbed endpoint provides the *real track title and cover*
// without an account, tokens or scraping. Search the playable audio by title.
export async function getSpotifyTrackMetadata(link, { fetcher = fetch } = {}) {
  let trackUrl;
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') return null;
    const match = /^\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
    if (!match) return null;
    trackUrl = `https://open.spotify.com/track/${match[1]}`;
  } catch {
    return null;
  }

  try {
    const response = await fetcher(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`,
      { signal: AbortSignal.timeout(3500), headers: { Accept: 'application/json' } },
    );
    if (!response?.ok) return null;
    const data = await response.json();
    const title = typeof data?.title === 'string' ? data.title.trim().slice(0, 200) : '';
    if (!title) return null;
    const cover = data?.thumbnail_url;
    return {
      title,
      artworkUrl: typeof cover === 'string' && /^https:\/\//i.test(cover) ? cover : null,
    };
  } catch {
    // Spotify may reject a private or deleted track. Preserve the original
    // music-server error instead of falsely claiming another title is a match.
    return null;
  }
}
