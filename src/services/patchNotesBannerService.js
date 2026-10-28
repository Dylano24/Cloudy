import { stripRustPatchLogo } from '../utils/rustPatchPresentation.js';
import { AttachmentBuilder } from 'discord.js';
import { withEmbedBuilderMessageMutation } from './embedBuilderMutationLock.js';
import { decodeHtmlEntities } from '../utils/decodeHtmlEntities.js';

const MAX_BANNER_BYTES = 8 * 1024 * 1024;
const MEDIA_HOSTS = new Set([
  'files.facepunch.com', 'rust.facepunch.com', 'newsimg.nitrado.net',
  'server.nitrado.net', 'web-wordpress-news-prod.ni.nitrado.net',
]);

function imageUrl(raw, base) {
  try {
    const url = new URL(decodeHtmlEntities(raw || ''), base);
    return raw && url.protocol === 'https:' && MEDIA_HOSTS.has(url.hostname) ? url.href : null;
  } catch { return null; }
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)]
    .map(([, key, , value]) => [key.toLowerCase(), decodeHtmlEntities(value)]));
}

function articleImages(html, base) {
  const tags = [...html.matchAll(/<(?:meta|img)\b[^>]*>/gi)].map(match => ({ tag: match[0], attrs: attributes(match[0]) }));
  const meta = key => tags.filter(({ tag, attrs }) => /^<meta/i.test(tag)
    && (attrs.property || attrs.name || '').toLowerCase() === key).map(({ attrs }) => attrs.content);
  const heroes = tags.filter(({ tag, attrs }) => /^<img/i.test(tag)
    && /(?:hero|banner|featured|wp-post-image)/i.test(attrs.class || '')).map(({ attrs }) => attrs.src || attrs['data-src']);
  return [...meta('og:image'), ...meta('twitter:image'), ...heroes]
    .map(raw => imageUrl(raw, base)).filter(Boolean);
}

function imageExtension(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (/^GIF8[79]a/.test(buffer.subarray(0, 6).toString())) return 'gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

async function downloadBanner(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok || !/^image\/(?:png|jpe?g|gif|webp)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
    throw new Error('Patch banner is not an accessible Discord image');
  }
  if (Number(response.headers.get('content-length')) > MAX_BANNER_BYTES) throw new Error('Patch banner is too large');
  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = imageExtension(buffer);
  if (!extension || buffer.length > MAX_BANNER_BYTES) throw new Error('Patch banner has invalid image data or size');
  const name = `patch-notes-banner.${extension}`;
  return { image: { url: `attachment://${name}` }, file: new AttachmentBuilder(buffer, { name }) };
}

// Upload the actual article image to Discord: a successful send no longer relies
// on Discord being able to hotlink the publisher's CDN later.
export async function preparePatchNotesBanner(article) {
  const attempted = new Set();
  const tryImages = async candidates => {
    for (const url of candidates) {
      if (!url || attempted.has(url)) continue;
      attempted.add(url);
      try { return await downloadBanner(url); } catch { /* Try this article's next image. */ }
    }
    return null;
  };
  const direct = await tryImages([imageUrl(article.image, article.link)]);
  if (direct) return direct;

  const response = await fetch(article.link, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Patch article HTTP ${response.status}`);
  const recovered = await tryImages(articleImages(await response.text(), article.link));
  if (recovered) return recovered;
  throw new Error(`No usable banner for ${article.link}; update will be retried`);
}

export function samePatchArticle(a, b) {
  const canonical = raw => {
    try { const url = new URL(raw); return `${url.origin}${url.pathname.replace(/\/+$/, '')}`; }
    catch { return ''; }
  };
  return Boolean(canonical(a)) && canonical(a) === canonical(b);
}

// Only the missing image is repaired. Saved text, style, other embeds and files
// stay exactly as they are; a deliberate existing banner is never replaced.
const activeBannerRepairs = new WeakSet();

export function isPatchBannerRepairInProgress(message) {
  return Boolean(message && activeBannerRepairs.has(message));
}

export async function repairMissingPatchBanner(message, article) {
  const needsBanner = embed => samePatchArticle(embed.url, article.link) && !embed.image?.url;
  const needsRepair = embed => needsBanner(embed) || (samePatchArticle(embed.url, article.link) && JSON.stringify(stripRustPatchLogo(embed)) !== JSON.stringify(embed));
  if (!message.embeds.some(embed => needsRepair(embed.toJSON()))) return false;
  const banner = message.embeds.some(embed => needsBanner(embed.toJSON())) ? await preparePatchNotesBanner(article) : null;
  return withEmbedBuilderMessageMutation(message.guildId, message.channelId, message.id, async () => {
    // A manual Save may have completed while the source image downloaded.
    const current = message.fetch ? await message.fetch(true) : message;
    const original = current.embeds.map(embed => embed.toJSON());
    const embeds = original.map(embed => samePatchArticle(embed.url, article.link) ? stripRustPatchLogo(embed) : embed);
    const missing = embeds.filter(needsBanner);
    if (!missing.length && JSON.stringify(original) === JSON.stringify(embeds)) return false;
    for (const embed of missing) {
      if (!banner) return false;
      embed.image = banner.image;
    }
    activeBannerRepairs.add(current);
    try {
      await current.edit({
        embeds,
        attachments: [...(current.attachments?.values() || [])].map(({ id }) => ({ id })),
        ...(banner && missing.length ? { files: [banner.file] } : {}),
      });
    } finally {
      activeBannerRepairs.delete(current);
    }
    return true;
  });
}

export function hasRequiredPatchBanner(data) {
  return Boolean(data?.image?.url)
    && /^https:\/\/(?:rust\.facepunch\.com\/news\/|server\.nitrado\.net\/(?:en-US|en-GB)\/news\/)/i.test(data?.url || '');
}
