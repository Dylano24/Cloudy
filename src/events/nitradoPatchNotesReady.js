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
const NITRADO_NEWS_URL = 'https://server.nitrado.net/en-US/news';
const LAST_NITRADO_KEY = `global:nitrado:patch-notes:${NITRADO_PATCH_CHANNEL_ID}:last-link:v1`;
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

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
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${key}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${key}["']`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return '';
}

function findLatestArticleLink(html) {
  const matches = [...html.matchAll(/href=["'](https:\/\/server\.nitrado\.net\/en-US\/news\/[^"'#?]+|\/en-US\/news\/[^"'#?]+)["']/gi)];

  for (const match of matches) {
    const raw = match[1];
    if (!raw || raw.endsWith('/news') || raw.includes('news-sitemap')) continue;
    return raw.startsWith('http') ? raw : `https://server.nitrado.net${raw}`;
  }

  return null;
}

async function fetchLatestNitradoArticle() {
  const listResponse = await fetch(`${NITRADO_NEWS_URL}?cloudy=${Date.now()}`, {
    headers: {
      'User-Agent': 'Cloudy Discord Bot/1.0',
      Accept: 'text/html,application/xhtml+xml',
      'Cache-Control': 'no-cache',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!listResponse.ok) {
    throw new Error(`Nitrado news returned HTTP ${listResponse.status}`);
  }

  const listHtml = await listResponse.text();
  const link = findLatestArticleLink(listHtml);
  if (!link) throw new Error('Could not find the latest Nitrado article link');

  const articleResponse = await fetch(`${link}${link.includes('?') ? '&' : '?'}cloudy=${Date.now()}`, {
    headers: {
      'User-Agent': 'Cloudy Discord Bot/1.0',
      Accept: 'text/html,application/xhtml+xml',
      'Cache-Control': 'no-cache',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!articleResponse.ok) {
    throw new Error(`Nitrado article returned HTTP ${articleResponse.status}`);
  }

  const articleHtml = await articleResponse.text();
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
      .setColor('#F28C28')
      .setAuthor({ name: 'NITRADO • OFFICIAL UPDATE' })
      .setTitle(article.title)
      .setURL(article.link)
      .setDescription(article.description || 'A new official Nitrado update is available.')
      .setFooter({ text: 'Cloudy Patch Notes • Source: Nitrado' })
      .setTimestamp(article.publishedAt ? new Date(article.publishedAt) : new Date());

    if (article.image) embed.setImage(article.image);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Read Full Update')
        .setEmoji('🛠️')
        .setStyle(ButtonStyle.Link)
        .setURL(article.link)
    );

    await channel.send({ embeds: [embed], components: [row] });
    await client.db?.set?.(LAST_NITRADO_KEY, article.link).catch(() => {});
    logger.info(`Posted Nitrado update: ${article.title}`);
    return true;
  } catch (error) {
    logger.warn('Nitrado update check failed:', error);
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
