import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { decodeHtmlEntities } from '../utils/decodeHtmlEntities.js';

const MAX_BODY_BYTES = 1_000_000;

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
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new Error('Website response is too large.');
    }
    chunks.push(Buffer.from(chunk));
  }
  return { url: url.href, text: Buffer.concat(chunks).toString('utf8') };
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

function normalizeItem({ title, link, description, image }, base) {
  const url = safeItemUrl(link, base);
  if (!title || !url) return null;
  const media = safeItemUrl(image, base);
  return {
    title: String(title).slice(0, 250),
    url,
    description: String(description || '').slice(0, 1000),
    image: media && media.startsWith('https:') ? media : null,
  };
}

export function parseFeedItems(xml, base) {
  const items = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks.slice(0, 100)) {
    const atom = /^<entry\b/i.test(block);
    const atomLink = atom
      ? (block.match(/<link\b[^>]*?\brel\s*=\s*['"]alternate['"][^>]*>/i)?.[0] || block.match(/<link\b[^>]*>/i)?.[0] || '')
      : '';
    const imageNode = block.match(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*>/i)?.[0] || '';
    const result = normalizeItem({
      title: tag(block, 'title'),
      link: atom ? attribute(atomLink, 'href') || tag(block, 'id') : tag(block, 'link') || tag(block, 'guid'),
      description: tag(block, 'description') || tag(block, 'summary') || tag(block, 'content'),
      image: attribute(imageNode, 'url') || attribute(block.match(/<img\b[^>]*>/i)?.[0] || '', 'src'),
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
    const image = article.match(/<img\b[^>]*>/i)?.[0] || '';
    const item = normalizeItem({
      title: decode(heading),
      link: attribute(anchor, 'href'),
      description: decode(paragraph),
      image: attribute(image, 'src'),
    }, base);
    if (item) found.push(item);
  }
  if (found.length) return found;
  // Plain webpages without article lists are a single post, never scraped as arbitrary media.
  const og = html.match(/<meta\b[^>]*property\s*=\s*['"]og:title['"][^>]*>/i)?.[0] || '';
  const title = attribute(og, 'content') || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const item = normalizeItem({ title, link: base, description: '', image: '' }, base);
  return item ? [item] : [];
}

export async function readWebsiteItems(sourceUrl) {
  const first = await downloadWebsite(sourceUrl);
  if (/<(?:rss|feed)\b/i.test(first.text)) return parseFeedItems(first.text, first.url);
  const alternate = htmlFeedUrl(first.text, first.url);
  if (alternate) {
    const feed = await downloadWebsite(alternate);
    const items = parseFeedItems(feed.text, feed.url);
    if (items.length) return items;
  }
  return parseWebsiteItems(first.text, first.url);
}
