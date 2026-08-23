import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  PermissionFlagsBits,
} from 'discord.js';
import { logger } from '../utils/logger.js';

const NITRADO_PATCH_CHANNEL_ID = '1539397467647377530';
const NITRADO_NEWS_SOURCES = [
  'https://server.nitrado.net/en-US/news',
  'https://server.nitrado.net/en-GB/news',
];
const NITRADO_SITEMAP_SOURCES = [
  'https://server.nitrado.net/sitemap.xml',
  'https://server.nitrado.net/sitemap_index.xml',
  'https://server.nitrado.net/news-sitemap.xml',
];
const KNOWN_RUST_ARTICLES = [
  'https://server.nitrado.net/en-US/news/the-rust-modular-vehicles-update-faster-safer-with-nitrado',
  'https://server.nitrado.net/en-US/news/rust-console-game-servers-are-here',
];
const LAST_NITRADO_KEY = `global:nitrado:patch-notes:${NITRADO_PATCH_CHANNEL_ID}:last-link:v2-rust-only`;
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const FAILURE_LOG_INTERVAL_MS = 60 * 60 * 1000;
const MAX_ARTICLES_TO_INSPECT = 80;
let lastFailureLogAt = 0;

function decodeHtml(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;|&#160;/g, ' ')
    .trim();
}

function stripHtml(value = '') {
  return decodeHtml(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readMeta(html, key) {
  const escapedKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escapedKey}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapedKey}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${escapedKey}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escapedKey}["']`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = String(html).match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return '';
}

function normalizeHtml(html = '') {
  return String(html)
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;|&#47;/gi, '/');
}

function toCanonicalArticleUrl(raw) {
  if (!raw) return null;

  try {
    const url = new URL(decodeHtml(raw), 'https://server.nitrado.net');
    if (url.hostname !== 'server.nitrado.net') return null;

    const pathname = url.pathname.replace(/\/{2,}/g, '/');
    const modern = pathname.match(/^\/(?:en-US|en-GB)\/news\/([^/?#]+)\/?$/i);
    const legacy = pathname.match(/^\/(?:usa|eng)\/news2\/view\/([^/?#]+)\/?$/i);
    const numericLegacy = pathname.match(/^\/eng\/news\/show\/(\d+)\/?$/i);
    if (!modern && !legacy && !numericLegacy) return null;

    const slug = (modern?.[1] || legacy?.[1] || numericLegacy?.[1] || '').replace(/^\/+|\/+$/g, '');
    if (!slug || ['page', 'category', 'tag', 'search', 'news-sitemap'].includes(slug.toLowerCase())) return null;

    url.search = '';
    url.hash = '';
    if (modern) url.pathname = `/en-US/news/${slug}`;
    else if (legacy) url.pathname = `/usa/news2/view/${slug}/`;
    else url.pathname = `/eng/news/show/${slug}`;
    return url.toString();
  } catch {
    return null;
  }
}

function extractArticleLinks(html = '') {
  const normalized = normalizeHtml(html);
  const links = [];
  const seen = new Set();
  const add = raw => {
    const canonical = toCanonicalArticleUrl(raw);
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    links.push(canonical);
  };

  for (const match of normalized.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
  for (const match of normalized.matchAll(/(?:https:\/\/server\.nitrado\.net)?\/(?:en-US|en-GB)\/news\/[a-z0-9][a-z0-9-_]*(?:\/)?/gi)) add(match[0]);
  for (const match of normalized.matchAll(/(?:https:\/\/server\.nitrado\.net)?\/(?:usa|eng)\/news2\/view\/[a-z0-9][a-z0-9-_]*(?:\/)?/gi)) add(match[0]);
  for (const match of normalized.matchAll(/(?:https:\/\/server\.nitrado\.net)?\/eng\/news\/show\/\d+(?:\/)?/gi)) add(match[0]);
  return links;
}

function parseSitemapUrls(xml = '') {
  const entries = [];
  for (const match of String(xml).matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    const block = match[1];
    const loc = decodeHtml(block.match(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/i)?.[1] || '');
    const link = toCanonicalArticleUrl(loc);
    if (!link) continue;
    const lastmodRaw = stripHtml(block.match(/<lastmod>([\s\S]*?)<\/lastmod>/i)?.[1] || '');
    const lastmod = Date.parse(lastmodRaw);
    entries.push({ link, lastmod: Number.isFinite(lastmod) ? lastmod : 0 });
  }
  return entries;
}

function parseSitemapIndex(xml = '') {
  const urls = [];
  for (const match of String(xml).matchAll(/<sitemap\b[^>]*>[\s\S]*?<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>[\s\S]*?<\/sitemap>/gi)) {
    try {
      const url = new URL(decodeHtml(match[1]));
      if (url.hostname === 'server.nitrado.net') urls.push(url.toString());
    } catch {}
  }
  return urls;
}

async function fetchText(url) {
  const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}cloudy=${Date.now()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CloudyDiscordBot/2.1; +https://discord.com)',
      Accept: 'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}`);
  return response.text();
}

function articleLooksLikeRustServerNews(html, link) {
  const title = readMeta(html, 'og:title') || stripHtml(String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const description = readMeta(html, 'og:description') || readMeta(html, 'description');
  const visible = stripHtml(html).slice(0, 24000);
  const haystack = `${link}\n${title}\n${description}\n${visible}`.toLowerCase();

  const mentionsRust = /\brust\b/.test(haystack);
  const serverRelated = /\b(server|servers|gameserver|hosting|console edition|devblog|update|wipe|oxide|performance|ddos)\b/.test(haystack);
  return mentionsRust && serverRelated;
}

function findArticleImage(html = '') {
  const metaImage = readMeta(html, 'og:image') || readMeta(html, 'twitter:image');
  if (metaImage) return metaImage;

  const imageTags = [...String(html).matchAll(/<img\b[^>]*>/gi)];
  for (const match of imageTags) {
    const tag = match[0];
    const src = decodeHtml(tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] || '');
    const alt = decodeHtml(tag.match(/\balt=["']([^"']*)["']/i)?.[1] || '');
    if (src && /rust/i.test(`${src} ${alt}`)) return src;
  }
  return null;
}

function buildArticle(link, html) {
  const title = readMeta(html, 'og:title')
    || stripHtml(String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
    || 'Nitrado Rust Server Update';
  const description = readMeta(html, 'og:description')
    || readMeta(html, 'description')
    || 'A new official Nitrado Rust server update is available.';
  const publishedAt = readMeta(html, 'article:published_time')
    || decodeHtml(String(html).match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1] || '')
    || null;

  return {
    title,
    link,
    description: stripHtml(description).slice(0, 3500),
    image: findArticleImage(html),
    publishedAt,
  };
}

async function collectSitemapCandidates(errors) {
  const queue = [...NITRADO_SITEMAP_SOURCES];
  const seenSitemaps = new Set();
  const candidates = [];

  while (queue.length && seenSitemaps.size < 20) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    try {
      const xml = await fetchText(sitemapUrl);
      candidates.push(...parseSitemapUrls(xml));
      for (const nested of parseSitemapIndex(xml)) {
        if (!seenSitemaps.has(nested)) queue.push(nested);
      }
    } catch (error) {
      errors.push(`${new URL(sitemapUrl).pathname}: ${error?.message || error}`);
    }
  }

  return candidates.sort((a, b) => b.lastmod - a.lastmod).map(entry => entry.link);
}

async function fetchLatestNitradoRustArticle() {
  const errors = [];
  const candidates = [];
  const seen = new Set();
  const add = link => {
    const canonical = toCanonicalArticleUrl(link);
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    candidates.push(canonical);
  };

  for (const sourceUrl of NITRADO_NEWS_SOURCES) {
    try {
      const html = await fetchText(sourceUrl);
      for (const link of extractArticleLinks(html)) add(link);
    } catch (error) {
      errors.push(`${new URL(sourceUrl).pathname}: ${error?.message || error}`);
    }
  }

  for (const link of await collectSitemapCandidates(errors)) add(link);
  for (const link of KNOWN_RUST_ARTICLES) add(link);

  for (const link of candidates.slice(0, MAX_ARTICLES_TO_INSPECT)) {
    try {
      const html = await fetchText(link);
      if (!articleLooksLikeRustServerNews(html, link)) continue;
      return buildArticle(link, html);
    } catch (error) {
      errors.push(`${new URL(link).pathname}: ${error?.message || error}`);
    }
  }

  throw new Error(`Could not find a Nitrado Rust server article (${errors.slice(-8).join('; ') || 'no matching articles'})`);
}

function logNitradoFailure(error) {
  const now = Date.now();
  if (now - lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS) {
    lastFailureLogAt = now;
    logger.warn(`Nitrado Rust update check unavailable: ${error?.message || error}`);
    return;
  }
  logger.debug(`Nitrado Rust update check still unavailable: ${error?.message || error}`);
}

async function checkForNitradoUpdate(client) {
  try {
    const article = await fetchLatestNitradoRustArticle();
    const channel = await client.channels.fetch(NITRADO_PATCH_CHANNEL_ID);
    if (!channel?.isTextBased()) throw new Error(`Channel ${NITRADO_PATCH_CHANNEL_ID} is not a text channel`);

    const botMember = channel.guild?.members?.me;
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    if (permissions && !permissions.has(required)) {
      throw new Error(`Cloudy needs View Channel, Send Messages and Embed Links in channel ${NITRADO_PATCH_CHANNEL_ID}`);
    }

    const previousLink = await client.db?.get?.(LAST_NITRADO_KEY).catch(() => null);
    try {
      const recentMessages = await channel.messages.fetch({ limit: 100 });
      const alreadyPosted = recentMessages.some(message =>
        message.author.id === client.user.id && message.embeds.some(embed => embed.url === article.link)
      );
      if (alreadyPosted) {
        if (previousLink !== article.link) await client.db?.set?.(LAST_NITRADO_KEY, article.link).catch(() => {});
        return true;
      }
    } catch (historyError) {
      logger.warn('Could not verify recent Nitrado Rust messages; using stored state.', historyError);
    }

    if (previousLink === article.link) return true;

    const embed = new EmbedBuilder()
      .setColor('#FFFFFF')
      .setAuthor({ name: 'NITRADO • OFFICIAL UPDATE' })
      .setTitle(article.title)
      .setURL(article.link)
      .setDescription(article.description || 'A new official Nitrado Rust server update is available.')
      .setFooter({ text: 'Cloudy Patch Notes • Source: Nitrado' })
      .setTimestamp(article.publishedAt ? new Date(article.publishedAt) : new Date());

    if (article.image) embed.setImage(article.image);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Read full patch notes')
        .setStyle(ButtonStyle.Link)
        .setURL(article.link)
    );

    await channel.send({ embeds: [embed], components: [row] });
    await client.db?.set?.(LAST_NITRADO_KEY, article.link).catch(() => {});
    lastFailureLogAt = 0;
    logger.info(`Posted Nitrado Rust server update: ${article.title}`);
    return true;
  } catch (error) {
    logNitradoFailure(error);
    return false;
  }
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    await checkForNitradoUpdate(client);
    const timer = setInterval(() => void checkForNitradoUpdate(client), CHECK_INTERVAL_MS);
    timer.unref?.();
    logger.info(`Nitrado Rust update monitor active for channel ${NITRADO_PATCH_CHANNEL_ID}`);
  },
};
