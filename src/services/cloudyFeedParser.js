import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { decodeHtmlEntities } from '../utils/decodeHtmlEntities.js';

// Large websites can exceed 1 MB in markup alone. Read a bounded prefix
// rather than rejecting useful articles when the rest of the page is huge.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export function validateSourceUrl(input) {
  let url;
  try { url = new URL(String(input || '').trim()); } catch { throw new Error('Enter a valid HTTPS website URL.'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
      || isIP(host) || !host.includes('.')
      || /(^|\.)(localhost|local|internal|invalid|test)$/.test(host)) {
    throw new Error('Only public HTTPS websites are supported.');
  }
  url.hash = '';
  return url;
}

export function publicIp(address) {
  if (isIP(address) === 6) return /^(2|3)[0-9a-f]{3}:/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 0 || b === 168)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113);
}

async function verifyPublicDns(url) {
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => !publicIp(entry.address))) {
    throw new Error('The website does not resolve to a public address.');
  }
}

// No user-supplied URL is fetched without DNS and redirect checks.
export async function downloadWebsite(raw, hops = 0) {
  const url = validateSourceUrl(raw);
  await verifyPublicDns(url);
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { 'User-Agent': 'CloudyFeed/1.0 (+Discord bot)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9' },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 300 && response.status < 400) {
    if (hops >= 2) throw new Error('Too many website redirects.');
    const next = response.headers.get('location');
    if (!next) throw new Error('Invalid website redirect.');
    return downloadWebsite(new URL(next, url).href, hops + 1);
  }
  if (!response.ok) throw new Error('Website returned HTTP ' + response.status);
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (type && !/(text\/html|application\/xhtml|xml|rss|atom)/.test(type)) {
    throw new Error('Website must provide an HTML, RSS or Atom page.');
  }
  const { text, truncated } = await readResponsePrefix(response.body);
  return { url: url.href, text, truncated };
}

// Download only a bounded portion, even if a site serves arbitrarily large HTML.
// The prefix often contains the site's RSS link or several complete articles.
// Cancel the remaining stream to avoid excess bandwidth and memory usage.
export async function readResponsePrefix(body, limitBytes = MAX_BODY_BYTES) {
  if (!body) return { text: '', truncated: false };
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > MAX_BODY_BYTES) {
    throw new Error('Invalid website read limit.');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let remaining = limitBytes;
  let truncated = false;
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const taken = Math.min(value.byteLength, remaining);
      chunks.push(decoder.decode(value.subarray(0, taken), { stream: true }));
      remaining -= taken;
      if (taken < value.byteLength) {
        truncated = true;
        break;
      }
    }
    if (remaining === 0) truncated = true;
    if (truncated) await reader.cancel().catch(() => {});
    return { text: chunks.join('') + decoder.decode(), truncated };
  } finally {
    reader.releaseLock();
  }
}

function decode(value) {
  return decodeHtmlEntities(String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function tag(block, tagName) {
  const escaped = tagName.replace(/:/g, ':');
  const match = block.match(new RegExp('<' + escaped + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + escaped + '>', 'i'));
  return match ? decode(match[1]) : '';
}

function attribute(markup, name) {
  const match = markup.match(new RegExp('\\b' + name + '\\s*=\\s*([\x22\x27])([\\s\\S]*?)\\1', 'i'));
  return match ? decodeHtmlEntities(match[2]) : '';
}

function safeItemUrl(value, base) {
  if (!value) return null;
  try {
    const candidate = new URL(value, base);
    return candidate.protocol === 'https:' || candidate.protocol === 'http:' ? candidate.href : null;
  } catch { return null; }
}

// Only explicit per-item geography counts. Locale, VPN or Railway geography
// cannot verify the origin of an individual photo or video.
export function normalizeMediaCountry(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ');
  return /^(?:us|usa|u s a|united states|united states of america|🇺🇸)$/.test(normalized) ? 'US' : null;
}

function htmlItemCountry(fragment) {
  const root = String(fragment || '').match(/<(?:article|figure|a|video)\b[^>]*>/i)?.[0] || '';
  return normalizeMediaCountry(attribute(root, 'data-country')
    || attribute(root, 'data-country-code')
    || attribute(root, 'data-origin-country'));
}

function rssItemCountry(block) {
  return normalizeMediaCountry(tag(block, 'country')
    || tag(block, 'dc:coverage')
    || tag(block, 'media:country'));
}

function videoObjectCountry(html) {
  // A public JSON-LD VideoObject with explicit countryOfOrigin or contentLocation.
  for (const script of String(html || '').matchAll(/<script\b[^>]*type\s*=\s*['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(script[1]); } catch { continue; }
    const queue = [data];
    while (queue.length) {
      const item = queue.shift();
      if (Array.isArray(item)) { queue.push(...item); continue; }
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
      const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
      if (!types.includes('VideoObject')) continue;
      const country = item.countryOfOrigin?.name || item.countryOfOrigin
        || item.contentLocation?.address?.addressCountry
        || item.contentLocation?.addressCountry;
      const code = normalizeMediaCountry(typeof country === 'object' ? country?.name : country);
      if (code) return code;
    }
  }
  return null;
}

function normalizeItem({ title, link, description, image, video, country }, base) {
  const url = safeItemUrl(link, base);
  if (!title || !url) return null;
  const media = safeItemUrl(image, base);
  const movie = safeItemUrl(video, base);
  return {
    title: String(title).slice(0, 250),
    url,
    description: String(description || '').slice(0, 1000),
    image: media && media.startsWith('https:') ? media : null,
    video: movie && movie.startsWith('https:') ? movie : null,
    country: normalizeMediaCountry(country),
  };
}

function imageFromTag(html) {
  const el = String(html || '').match(/<img\b[^>]*>/i)?.[0] || '';
  return attribute(el, 'data-src') || attribute(el, 'src') || '';
}

function videoFromTag(html) {
  const el = String(html || '').match(/<video\b[^>]*>/i)?.[0] || '';
  const source = String(html || '').match(/<source\b[^>]*>/i)?.[0] || '';
  return attribute(el, 'src') || attribute(el, 'data-src')
    || attribute(source, 'src') || attribute(source, 'data-src') || '';
}

function mediaAttrs(block) {
  const tags = block.match(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*>/gi) || [];
  const media = { image: '', video: '' };
  for (const t of tags) {
    const url = attribute(t, 'url');
    const mime = (attribute(t, 'type') || attribute(t, 'medium')).toLowerCase();
    const isVideo = /^video\b/.test(mime) || /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(url);
    const isImage = /^image\b/.test(mime) || /<media:thumbnail\b/i.test(t) || /\.(?:jpe?g|png|gif|webp)(?:[?#]|$)/i.test(url);
    if (isVideo && !media.video) media.video = url;
    if (isImage && !media.image) media.image = url;
  }
  return media;
}

export function parseFeedItems(xml, base) {
  const items = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks.slice(0, 100)) {
    const atom = /^<entry\b/i.test(block);
    const atomLink = atom
      ? (block.match(/<link\b[^>]*?\brel\s*=\s*['"]alternate['"][^>]*>/i)?.[0] || block.match(/<link\b[^>]*>/i)?.[0] || '')
      : '';
    const foundMedia = mediaAttrs(block);
    const result = normalizeItem({
      title: tag(block, 'title'),
      link: atom ? attribute(atomLink, 'href') || tag(block, 'id') : tag(block, 'link') || tag(block, 'guid'),
      description: tag(block, 'description') || tag(block, 'summary') || tag(block, 'content'),
      image: foundMedia.image || imageFromTag(block),
      video: foundMedia.video || videoFromTag(block),
      country: rssItemCountry(block),
    }, base);
    if (result) items.push(result);
  }
  return items;
}

export function htmlFeedUrl(html, base) {
  for (const node of html.match(/<link\b[^>]*>/gi) || []) {
    if (/rss\+xml|atom\+xml/i.test(node)) {
      const link = safeItemUrl(attribute(node, 'href'), base);
      if (link?.startsWith('https:')) return link;
    }
  }
  return null;
}

export function parseWebsiteItems(html, base) {
  const found = [];
  const articles = html.match(/<article\b[\s\S]*?<\/article>/gi) || [];
  for (const article of articles.slice(0, 100)) {
    const anchor = article.match(/<a\b[^>]*href\s*=\s*['"][^'"]+['"][^>]*>/i)?.[0] || '';
    const heading = article.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i)?.[1] || '';
    const paragraph = article.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '';
    const image = imageFromTag(article);
    const video = videoFromTag(article);
    const item = normalizeItem({
      title: decode(heading),
      link: attribute(anchor, 'href'),
      description: decode(paragraph),
      image,
      video,
      country: htmlItemCountry(article),
    }, base);
    if (item) found.push(item);
  }
  if (found.some(item => item.image || item.video)) return found;

  // A gallery can contain photos or videos in figure blocks rather than
  // article blocks. Do not treat navigation icons, avatars or branding as posts.
  const figures = html.match(/<figure\b[\s\S]*?<\/figure>/gi) || [];
  for (const figure of figures.slice(0, 100)) {
    const image = imageFromTag(figure);
    const video = videoFromTag(figure);
    if (!image && !video) continue;
    const caption = decode(figure.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1] || '');
    const anchor = figure.match(/<a\b[^>]*>/i)?.[0] || '';
    const title = caption || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') || 'Media';
    const item = normalizeItem({ title, link: attribute(anchor, 'href') || base, image, video,
      country: htmlItemCountry(figure), description: '' }, base);
    if (item) found.push(item);
  }
  if (found.some(item => item.image || item.video)) return found.filter(item => item.image || item.video);

  // Some public photo galleries use image links rather than figure/article tags.
  // Ignore navigation graphics, logos, avatars and other non-post images.
  const images = html.match(/<a\b[^>]*>[\s\S]*?<img\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  for (const block of images.slice(0, 100)) {
    const image = imageFromTag(block);
    if (!/\.(?:jpe?g|png|gif|webp)(?:[?#]|$)/i.test(image)) continue;
    if (/(?:avatar|logo|icon|badge|emoji|sprite|thumbnail-placeholder)/i.test(image)) continue;
    const imgTag = block.match(/<img\b[^>]*>/i)?.[0] || '';
    const width = Number(attribute(imgTag, 'width'));
    if (width > 0 && width < 160) continue;
    const anchor = block.match(/<a\b[^>]*>/i)?.[0] || '';
    const title = attribute(imgTag, 'alt')
      || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') || 'Photo';
    const item = normalizeItem({ title, link: attribute(anchor, 'href') || base, image,
      country: htmlItemCountry(block) }, base);
    if (item) found.push(item);
  }
  if (found.some(item => item.image || item.video)) return found.filter(item => item.image || item.video);

  // On a single-video post, the video tag may not be inside an article.
  const directVideo = videoFromTag(html);
  if (directVideo) {
    const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') || 'Video';
    const previewTag = html.match(/<video\b[^>]*>/i)?.[0] || '';
    const item = normalizeItem({
      title, link: base, video: directVideo, image: attribute(previewTag, 'poster'),
      country: htmlItemCountry(html.match(/<video\b[^>]*>/i)?.[0] || '') || videoObjectCountry(html),
    }, base);
    if (item) return [item];
  }

  // Keep text-only article support, but allow photo/video discovery before fallback.
  if (found.length) return found;

  // Plain webpages without article lists are a single post, never scraped as arbitrary media.
  const og = html.match(/<meta\b[^>]*property\s*=\s*['"]og:title['"][^>]*>/i)?.[0] || '';
  const title = attribute(og, 'content') || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const item = normalizeItem({ title, link: base, description: '', image: '' }, base);
  return item ? [item] : [];
}

export async function readWebsiteItems(sourceUrl) {
  const directUrl = validateSourceUrl(sourceUrl).href;
  // Public direct media URLs can be posted without scraping or downloading files.
  if (/\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(directUrl)) {
    return [{ title: 'Video', url: directUrl, description: '', image: null, video: directUrl, country: null }];
  }
  if (/\.(?:jpe?g|png|gif|webp)(?:[?#]|$)/i.test(directUrl)) {
    return [{ title: 'Photo', url: directUrl, description: '', image: directUrl, video: null, country: null }];
  }
  const first = await downloadWebsite(directUrl);
  if (/<(?:rss|feed)\b/i.test(first.text)) return parseFeedItems(first.text, first.url);
  const alternate = htmlFeedUrl(first.text, first.url);
  if (alternate) {
    const feed = await downloadWebsite(alternate);
    const items = parseFeedItems(feed.text, feed.url);
    if (items.length) return items;
  }
  return parseWebsiteItems(first.text, first.url);
}
