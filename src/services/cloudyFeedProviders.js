// Provider-specific discovery for public media only. No cookies, login,
 // scraping around access controls or third-party download executables.
const API_ROOT = 'https://api.redgifs.com';
const MAX_JSON_BYTES = 1024 * 1024;
const API_TIMEOUT = 10_000;
let temporaryToken = null;
let temporaryTokenExpiresAt = 0;

function providerHost(hostname, domain) {
  return hostname === domain || hostname.endsWith('.' + domain);
}

export function cloudyMediaProvider(source) {
  let parsed;
  try { parsed = new URL(source); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (providerHost(parsed.hostname.toLowerCase(), 'redgifs.com')) return 'redgifs';
  if (providerHost(parsed.hostname.toLowerCase(), 'erome.com')) return 'erome';
  return null;
}

function httpsUrl(value, base) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function countryTag(value, normalizeCountry) {
  if (!value || typeof value !== 'string') return null;
  return normalizeCountry(value);
}

async function boundedJson(response) {
  if (!response.ok) throw new Error('Media provider returned HTTP ' + response.status);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_JSON_BYTES) throw new Error('Media provider response is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Media provider response is empty.');
  let size = 0;
  const chunks = [];
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('Media provider response is too large.');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(chunks.join('') + decoder.decode()); }
  catch { throw new Error('Media provider returned invalid JSON.'); }
}

async function redgifsRequest(path, token = '') {
  if (!path.startsWith('/v2/')) throw new Error('Unsupported media API endpoint.');
  const url = new URL(path, API_ROOT);
  if (url.origin !== API_ROOT) throw new Error('Unsupported media API endpoint.');
  let response;
  try {
    response = await fetch(url, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(API_TIMEOUT),
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
    });
  } catch { throw new Error('RedGIFs API is unavailable.'); }
  return boundedJson(response);
}

async function redgifsToken(getJson) {
  if (getJson !== redgifsRequest) {
    const response = await getJson('/v2/auth/temporary');
    if (!response?.token) throw new Error('RedGIFs temporary authorization is unavailable.');
    return response.token;
  }
  if (temporaryToken && Date.now() < temporaryTokenExpiresAt) return temporaryToken;
  const response = await getJson('/v2/auth/temporary');
  if (typeof response?.token !== 'string' || response.token.length < 10) {
    throw new Error('RedGIFs temporary authorization is unavailable.');
  }
  temporaryToken = response.token;
  temporaryTokenExpiresAt = Date.now() + 8 * 60_000;
  return temporaryToken;
}

export function redgifsEndpoint(source) {
  const url = new URL(source);
  if (!providerHost(url.hostname.toLowerCase(), 'redgifs.com')) {
    throw new Error('Enter a RedGIFs URL.');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const options = 'page=1&count=30&type=g';
  const identifier = value => {
    if (!/^[a-z0-9_-]{1,64}$/i.test(value || '')) {
      throw new Error('Invalid RedGIFs identifier.');
    }
    return encodeURIComponent(value.toLowerCase());
  };
  if (parts[0] === 'watch' && parts.length === 2) {
    return '/v2/gifs/' + identifier(parts[1]);
  }
  if (parts[0] === 'users' && parts.length === 2) {
    return '/v2/users/' + identifier(parts[1]) + '/search?' + options + '&order=recent';
  }
  if (parts[0] === 'gifs' && parts.length === 2) {
    return '/v2/gifs/search?' + options + '&order=trending&search_text=' + identifier(parts[1]);
  }
  if (parts.length === 0 || parts[0] === 'browse' || parts[0] === 'search') {
    const tag = url.searchParams.get('tags') || url.searchParams.get('query');
    if (tag && /^[a-z0-9_+ -]{1,80}$/i.test(tag)) {
      return '/v2/gifs/search?' + options + '&order=trending&search_text=' + encodeURIComponent(tag);
    }
    // Public trending search route. API may reject this on accounts/regions
    // without discovery access; never fall back to unauthorized scraping.
    return '/v2/search/gifs?' + options + '&order=trending';
  }
  throw new Error('Use the RedGIFs homepage, browse, user or watch URL.');
}

export function normalizeRedgifsItems(payload, normalizeCountry) {
  const records = Array.isArray(payload?.gifs) ? payload.gifs
    : payload?.gif ? [payload.gif] : [];
  const items = [];
  for (const record of records.slice(0, 60)) {
    if (!record || typeof record.id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(record.id)) continue;
    const video = httpsUrl(record.urls?.sd) || httpsUrl(record.urls?.hd);
    if (!video) continue;
    const image = httpsUrl(record.urls?.poster) || httpsUrl(record.urls?.thumbnail);
    const country = countryTag(typeof record.country === 'string' ? record.country
      : record.countryCode || record.countryOfOrigin, normalizeCountry);
    items.push({
      title: typeof record.title === 'string' ? record.title.slice(0, 250) : 'RedGIFs video',
      url: 'https://www.redgifs.com/watch/' + record.id.toLowerCase(),
      video, image, country, description: '',
    });
  }
  return items;
}

export async function redgifsMedia(source, normalizeCountry, getJson = redgifsRequest) {
  const path = redgifsEndpoint(source);
  const token = await redgifsToken(getJson);
  const result = await getJson(path, token);
  return normalizeRedgifsItems(result, normalizeCountry);
}

function attribute(markup, name) {
  const result = String(markup || '').match(new RegExp('\\b' + name
    + '\\s*=\\s*([\\x22\\x27])([\\s\\S]*?)\\1', 'i'));
  return result ? result[2].replace(/&amp;/gi, '&') : '';
}

function explicitCountry(markup, normalizeCountry) {
  const root = String(markup || '').match(/<(?:video|div|figure|article)\b[^>]*>/i)?.[0] || '';
  return countryTag(attribute(root, 'data-country') || attribute(root, 'data-country-code')
    || attribute(root, 'data-origin-country'), normalizeCountry);
}

export function parseEromeAlbum(html, albumUrl, normalizeCountry) {
  const items = [];
  const albumTitle = String(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Erome album')
    .replace(/<[^>]*>/g, '').trim().slice(0, 150);
  const videos = html.match(/<video\b[^>]*>[\s\S]*?<\/video>/gi) || [];
  for (const [index, block] of videos.slice(0, 50).entries()) {
    const first = block.match(/<video\b[^>]*>/i)?.[0] || '';
    const source = block.match(/<source\b[^>]*>/i)?.[0] || '';
    const video = httpsUrl(attribute(first, 'src') || attribute(source, 'src')
      || attribute(first, 'data-src') || attribute(source, 'data-src'), albumUrl);
    if (!video || !/\.(?:mp4|webm)(?:[?#]|$)/i.test(video)) continue;
    items.push({
      title: albumTitle + (videos.length > 1 ? ' ' + (index + 1) : ''),
      url: albumUrl, video,
      image: httpsUrl(attribute(first, 'poster'), albumUrl),
      country: explicitCountry(first, normalizeCountry),
      description: '',
    });
  }
  const photos = html.match(/<div\b[^>]*class\s*=\s*['"][^'"]*\bimg\b[^'"]*['"][^>]*>[\s\S]*?<\/div>/gi) || [];
  for (const block of photos.slice(0, 50)) {
    const img = block.match(/<img\b[^>]*>/i)?.[0] || '';
    const image = httpsUrl(attribute(img, 'data-src') || attribute(img, 'src'), albumUrl);
    if (!image || !/\.(?:jpe?g|png|gif|webp)(?:[?#]|$)/i.test(image)) continue;
    items.push({ title: albumTitle, url: albumUrl, image, video: null,
      country: explicitCountry(block, normalizeCountry), description: '' });
  }
  return items;
}

export function discoverEromeAlbums(html, source) {
  const found = [];
  const unique = new Set();
  for (const match of String(html).matchAll(/<a\b[^>]*href\s*=\s*['"]([^'"]+)['"][^>]*>/gi)) {
    const url = httpsUrl(match[1], source);
    if (!url) continue;
    const parsed = new URL(url);
    if (!providerHost(parsed.hostname.toLowerCase(), 'erome.com')
        || !/^\/a\/[a-z0-9_-]{1,100}\/?$/i.test(parsed.pathname)
        || unique.has(parsed.href)) continue;
    unique.add(parsed.href);
    found.push(parsed.href);
    if (found.length >= 25) break;
  }
  return found;
}

export async function eromeMedia(source, normalizeCountry, downloader) {
  const url = new URL(source);
  if (!providerHost(url.hostname.toLowerCase(), 'erome.com')) throw new Error('Enter an Erome URL.');
  const isAlbum = /^\/a\/[a-z0-9_-]{1,100}\/?$/i.test(url.pathname);
  const isIndex = url.pathname === '/' || /^\/(?:explore|search)(?:\/[^/]*)?\/?$/i.test(url.pathname);
  if (!isAlbum && !isIndex) throw new Error('Use a public Erome album or explore page.');
  const first = await downloader(source);
  if (isAlbum) return parseEromeAlbum(first.text, first.url, normalizeCountry);
  const albumUrls = discoverEromeAlbums(first.text, first.url);
  if (!albumUrls.length) throw new Error('No public Erome albums found on this page.');
  // Small bounded sampling; never bulk-crawl or hammer the source.
  const selected = albumUrls.slice(0, 3);
  const items = [];
  for (const album of selected) {
    try {
      const page = await downloader(album);
      items.push(...parseEromeAlbum(page.text, page.url, normalizeCountry));
    } catch {
      // Some albums may be removed, blocked or private; do not bypass them.
    }
  }
  return items.slice(0, 60);
}

export async function readCloudyProviderItems(source, { normalizeCountry, downloader, getJson } = {}) {
  const kind = cloudyMediaProvider(source);
  if (!kind) return null;
  if (kind === 'redgifs') return redgifsMedia(source, normalizeCountry, getJson || redgifsRequest);
  if (!downloader) throw new Error('Erome source reader is unavailable.');
  return eromeMedia(source, normalizeCountry, downloader);
}
