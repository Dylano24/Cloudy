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
const NITRADO_RSS_SOURCES = [
  'https://server.nitrado.net/eng/news/rss/eng.rss',
];
const NITRADO_NEWS_SOURCES = [
  'https://server.nitrado.net/en-US/news',
  'https://server.nitrado.net/en-GB/news',
  'https://server.nitrado.net/usa/',
  'https://server.nitrado.net/eng/',
];
const NITRADO_SITEMAP_SOURCES = [
  'https://server.nitrado.net/sitemap.xml',
  'https://server.nitrado.net/sitemap_index.xml',
  'https://server.nitrado.net/news-sitemap.xml',
];
const LAST_NITRADO_KEY = `global:nitrado:patch-notes:${NITRADO_PATCH_CHANNEL_ID}:last-link:v1`;
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const FAILURE_LOG_INTERVAL_MS = 60 * 60 * 1000;
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
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return '';
}

function normalizeNitradoHtml(html = '') {
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
    const modernMatch = pathname.match(/^\/(?:en-US|en-GB)\/news\/([^/?#]+)\/?$/i);
    const legacyMatch = pathname.match(/^\/(?:usa|eng)\/news2\/view\/([^/?#]+)\/?$/i);
    const numericLegacyMatch = pathname.match(/^\/eng\/news\/show\/(\d+)\/?$/i);

    if (!modernMatch && !legacyMatch && !numericLegacyMatch) return null;

    const slug = (modernMatch?.[1] || legacyMatch?.[1] || numericLegacyMatch?.[1] || '')
      .replace(/^\/+|\/+$/g, '');
    if (!slug || ['page', 'category', 'tag', 'search', 'news-sitemap'].includes(slug.toLowerCase())) {
      return null;
    }

    url.search = '';
    url.hash = '';

    if (modernMatch) {
      url.pathname = `/en-US/news/${slug}`;
    } else if (legacyMatch) {
      url.pathname = `/usa/news2/view/${slug}/`;
    } else {
      url.pathname = `/eng/news/show/${slug}`;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function findLatestArticleLink(html) {
  const normalizedHtml = normalizeNitradoHtml(html);
  const candidates = [];
  const seen = new Set();

  const addCandidate = (raw) => {
    const canonical = toCanonicalArticleUrl(raw);
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    candidates.push(canonical);
  };

  for (const match of normalizedHtml.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    addCandidate(match[1]);
  }

  const routePatterns = [
    /(?:https:\/\/server\.nitrado\.net)?\/(?:en-US|en-GB)\/news\/[a-z0-9][a-z0-9-_]*(?:\/)?/gi,
    /(?:https:\/\/server\.nitrado\.net)?\/(?:usa|eng)\/news2\/view\/[a-z0-9][a-z0-9-_]*(?:\/)?/gi,
    /(?:https:\/\/server\.nitrado\.net)?\/eng\/news\/show\/\d+(?:\/)?/gi,
  ];

  for (const routePattern of routePatterns) {
    for (const match of normalizedHtml.matchAll(routePattern)) {
      addCandidate(match[0]);
    }
  }

  return candidates[0] || null;
}

function findLatestArticleLinkFromRss(xml = '') {
  const firstItem = String(xml).match(/<item\b[\s\S]*?<\/item>/i)?.[0] || String(xml);
  const linkMatch = firstItem.match(/<link>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/link>/i);
  if (linkMatch?.[1]) {
    const canonical = toCanonicalArticleUrl(stripHtml(linkMatch[1]));
    if (canonical) return canonical;
  }

  for (const match of firstItem.matchAll(/https:\/\/server\.nitrado\.net\/[^\s<"']+/gi)) {
    const canonical = toCanonicalArticleUrl(match[0]);
    if (canonical) return canonical;
  }

  return null;
}

function parseSitemapUrls(xml = '') {
  const entries = [];
  const source = String(xml);
  for (const match of source.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    const block = match[1];
    const loc = decodeHtml(block.match(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/i)?.[1] || '');
    const canonical = toCanonicalArticleUrl(loc);
    if (!canonical) continue;
    const lastmodRaw = stripHtml(block.match(/<lastmod>([\s\S]*?)<\/lastmod>/i)?.[1] || '');
    const lastmod = Date.parse(lastmodRaw);
    entries.push({ link: canonical, lastmod: Number.isFinite(lastmod) ? lastmod : 0 });
  }
  return entries.sort((a, b) => b.lastmod - a.lastmod);
}

function parseSitemapIndex(xml = '') {
  const urls = [];
  for (const match of String(xml).matchAll(/<sitemap\b[^>]*>[\s\S]*?<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>[\s\S]*?<\/sitemap>/gi)) {
    const raw = decodeHtml(match[1]);
    try {
      const url = new URL(raw);
      if (url.hostname === 'server.nitrado.net') urls.push(url.toString());
    } catch {}
  }
  return urls;
}

async function fetchText(url) {
  const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}cloudy=${Date.now()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CloudyDiscordBot/2.1; +https://discord.com)',
      Accept: 'text/html,application/xhtml+xml,application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}`);
  }

  return response.text();
}

async function discoverFromSitemap(errors) {
  const seenSitemaps = new Set();
  const queue = [...NITRADO_SITEMAP_SOURCES];
  let best = null;

  while (queue.length && seenSitemaps.size < 20) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    try {
      const xml = await fetchText(sitemapUrl);
      const entries = parseSitemapUrls(xml);
      if (entries.length) {
        const candidate = entries[0];
        if (!best || candidate.lastmod > best.lastmod) best = candidate;
      }

      const nested = parseSitemapIndex(xml);
      for (const nestedUrl of nested) {
        if (!seenSitemaps.has(nestedUrl)) queue.push(nestedUrl);
      }
    } catch (error) {
      errors.push(`${new URL(sitemapUrl).pathname}: ${error?.message || error}`);
    }
  }

  return best?.link || null;
}

async function discoverLatestNitradoArticleLink() {
  const errors = [];

  for (const rssUrl of NITRADO_RSS_SOURCES) {
    try {
      const xml = await fetchText(rssUrl);
      const link = findLatestArticleLinkFromRss(xml);
      if (link) return link;
      errors.push(`${new URL(rssUrl).pathname}: no article links`);
    } catch (error) {
      errors.push(`${new URL(rssUrl).pathname}: ${error?.message || error}`);
    }
  }

  for (const sourceUrl of NITRADO_NEWS_SOURCES) {
    try {
      const html = await fetchText(sourceUrl);
      const link = findLatestArticleLink(html);
      if (link) return link;
      errors.push(`${new URL(sourceUrl).pathname}: no article links`);
    } catch (error) {
      errors.push(`${new URL(sourceUrl).pathname}: ${error?.message || error}`);
    }
  }

  const sitemapLink = await discoverFromSitemap(errors);
  if (sitemapLink) return sitemapLink;

  throw new Error(`Could not find the latest Nitrado article link (${errors.join('; ')})`);
}

async function fetchLatestNitradoArticle() {
  const link = await discoverLatestNitradoArticleLink();
  const articleHtml = await fetchText(link);

  const title = readMeta(articleHtml, 'og:title')
    || stripHtml(articleHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
    || 'Nitrado Update';
  const description = readMeta(articleHtml, 'og:description')
    || readMeta(articleHtml, 'description')
    || 'A new official Nitrado update is available.';
  const image = readMeta(articleHtml, 'og:image') || null;
  const publishedAt = readMeta(articleHtml, 'article:published_time') || null;

  return {
    title,
    link,
    description: stripHtml(description).slice(0, 3500),
    image,
    publishedAt,
  };
}

function logNitradoFailure(error) {
  const now = Date.now();
  if (now - lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS) {
    lastFailureLogAt = now;
    logger.warn(`Nitrado update check unavailable: ${error?.message || error}`);
    return;
  }

  logger.debug(`Nitrado update check still unavailable: ${error?.message || error}`);
}

async function checkForNitradoUpdate(client) {
  try {
    const article = await fetchLatestNitradoArticle();
    const channel = await client.channels.fetch(NITRADO_PATCH_CHANNEL_ID);

    if (!channel?.isTextBased()) {
      throw new Error(`Channel ${NITRADO_PATCH_CHANNEL_ID} is not a text channel`);
    }

    const botMember = channel.guild?.members?.me;
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    const requiredPermissions = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ];

    if (permissions && !permissions.has(requiredPermissions)) {
      throw new Error(`Cloudy needs View Channel, Send Messages and Embed Links in channel ${NITRADO_PATCH_CHANNEL_ID}`);
    }

    const previousLink = await client.db?.get?.(LAST_NITRADO_KEY).catch(() => null);

    try {
      const recentMessages = await channel.messages.fetch({ limit: 100 });
      const alreadyPosted = recentMessages.some(message =>
        message.author.id === client.user.id
        && message.embeds.some(embed => embed.url === article.link)
      );

      if (alreadyPosted) {
        if (previousLink !== article.link) {
          await client.db?.set?.(LAST_NITRADO_KEY, article.link).catch(() => {});
        }
        return true;
      }
    } catch (historyError) {
      logger.warn('Could not verify recent Nitrado update messages; using stored state.', historyError);
    }

    if (previousLink === article.link) return true;

    const embed = new EmbedBuilder()
      .setColor('#FFFFFF')
      .setAuthor({ name: 'NITRADO • OFFICIAL UPDATE' })
      .setTitle(article.title)
      .setURL(article.link)
      .setDescription(article.description || 'A new official Nitrado update is available.')
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
    logger.info(`Posted Nitrado update: ${article.title}`);
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

    const timer = setInterval(() => {
      void checkForNitradoUpdate(client);
    }, CHECK_INTERVAL_MS);

    timer.unref?.();
    logger.info(`Nitrado update monitor active for channel ${NITRADO_PATCH_CHANNEL_ID}`);
  },
};
