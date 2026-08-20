import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';

const KEY_PREFIX = 'patch:subscriptions:';
const POLL_INTERVAL_MS = 10 * 60_000;
const MAX_SUBSCRIPTIONS = 50;

function key(guildId) {
  return `${KEY_PREFIX}${guildId}`;
}

function decodeXml(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim();
}

async function fetchText(url, { timeoutMs = 15_000, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'CloudyManager/1.0 (+Discord update monitor)',
        Accept: '*/*',
        ...headers,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Update provider returned invalid JSON');
  }
}

function normalizeRepository(input) {
  const raw = String(input || '').trim();
  const match = raw.match(/(?:github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (!match) throw new Error('Use a GitHub repository like `owner/repo`.');
  return `${match[1]}/${match[2].replace(/\.git$/i, '')}`;
}

function normalizeSteamAppId(input) {
  const raw = String(input || '').trim();
  const match = raw.match(/(?:store\.steampowered\.com\/app\/)?(\d{1,12})/);
  if (!match) throw new Error('Use a Steam App ID or Steam store URL.');
  return match[1];
}

function normalizeHttpUrl(input) {
  const raw = String(input || '').trim();
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP/HTTPS feeds are supported.');
  return url.toString();
}

function parseRssOrAtom(xml) {
  const channelTitle = decodeXml(
    xml.match(/<channel[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      || xml.match(/<feed[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      || 'Update Feed'
  );

  const blocks = [
    ...[...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]),
    ...[...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]),
  ];

  const items = blocks.map((block) => {
    const title = decodeXml(block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Untitled update');
    const description = decodeXml(
      block.match(/<(?:description|summary|content)(?:\s[^>]*)?>([\s\S]*?)<\/(?:description|summary|content)>/i)?.[1] || ''
    );
    const guid = decodeXml(
      block.match(/<(?:guid|id)[^>]*>([\s\S]*?)<\/(?:guid|id)>/i)?.[1] || ''
    );
    const pubDate = decodeXml(
      block.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i)?.[1] || ''
    );
    const linkTag = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>(?:<\/link>)?/i)?.[1];
    const linkText = decodeXml(block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] || '');
    const url = linkTag || linkText || null;

    return {
      id: guid || url || `${title}:${pubDate}`,
      title,
      description,
      url,
      publishedAt: pubDate || null,
    };
  });

  return { title: channelTitle, items };
}

export async function getSteamNews(appInput, count = 10) {
  const appId = normalizeSteamAppId(appInput);
  const url = new URL('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/');
  url.searchParams.set('appid', appId);
  url.searchParams.set('count', String(Math.max(1, Math.min(25, count))));
  url.searchParams.set('maxlength', '2500');
  url.searchParams.set('format', 'json');

  const data = await fetchJson(url.toString());
  const appnews = data?.appnews;
  const items = (appnews?.newsitems || []).map((item) => ({
    id: String(item.gid || item.url || item.title),
    title: item.title || 'Steam update',
    description: String(item.contents || '').replace(/\{STEAM_CLAN_IMAGE\}[^\s]*/g, '').slice(0, 2500),
    url: item.url || `https://store.steampowered.com/news/app/${appId}`,
    publishedAt: item.date ? new Date(Number(item.date) * 1000).toISOString() : null,
    author: item.author || null,
  }));

  return {
    provider: 'steam',
    source: appId,
    title: appnews?.appid ? `Steam App ${appnews.appid}` : `Steam App ${appId}`,
    items,
  };
}

export async function getGitHubReleases(repoInput, count = 10) {
  const repo = normalizeRepository(repoInput);
  const data = await fetchJson(
    `https://api.github.com/repos/${encodeURIComponent(repo.split('/')[0])}/${encodeURIComponent(repo.split('/')[1])}/releases?per_page=${Math.max(1, Math.min(25, count))}`,
    { headers: { Accept: 'application/vnd.github+json' } },
  );

  if (!Array.isArray(data)) throw new Error('GitHub release feed was unavailable.');

  const items = data.map((release) => ({
    id: String(release.id || release.tag_name || release.html_url),
    title: release.name || release.tag_name || 'GitHub release',
    description: String(release.body || '').slice(0, 2500),
    url: release.html_url || `https://github.com/${repo}/releases`,
    publishedAt: release.published_at || release.created_at || null,
    author: release.author?.login || null,
  }));

  return {
    provider: 'github',
    source: repo,
    title: `${repo} Releases`,
    items,
  };
}

export async function getRssFeed(feedUrl) {
  const normalized = normalizeHttpUrl(feedUrl);
  const xml = await fetchText(normalized);
  const parsed = parseRssOrAtom(xml);
  return {
    provider: 'rss',
    source: normalized,
    title: parsed.title,
    items: parsed.items.slice(0, 25),
  };
}

export async function getEpicFreeGames({ country = 'US', locale = 'en-US' } = {}) {
  const url = new URL('https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions');
  url.searchParams.set('locale', locale);
  url.searchParams.set('country', country.toUpperCase());
  url.searchParams.set('allowCountries', country.toUpperCase());

  const data = await fetchJson(url.toString());
  const elements = data?.data?.Catalog?.searchStore?.elements || [];
  const now = Date.now();

  return elements.map((game) => {
    const promotions = [
      ...(game.promotions?.promotionalOffers || []),
      ...(game.promotions?.upcomingPromotionalOffers || []),
    ].flatMap((group) => group.promotionalOffers || []);

    const free = promotions.find((promo) =>
      Number(promo.discountSetting?.discountPercentage) === 0
    );

    if (!free) return null;
    const start = free.startDate ? new Date(free.startDate).getTime() : null;
    const end = free.endDate ? new Date(free.endDate).getTime() : null;
    const active = (!start || start <= now) && (!end || end > now);

    const slug = game.catalogNs?.mappings?.[0]?.pageSlug
      || game.offerMappings?.[0]?.pageSlug
      || game.productSlug
      || null;

    return {
      id: String(game.id || game.namespace || game.title),
      title: game.title || 'Free Game',
      description: game.description || null,
      image: game.keyImages?.find((image) => image.type === 'OfferImageWide')?.url
        || game.keyImages?.[0]?.url
        || null,
      url: slug ? `https://store.epicgames.com/p/${slug}` : 'https://store.epicgames.com/free-games',
      startAt: start ? new Date(start).toISOString() : null,
      endAt: end ? new Date(end).toISOString() : null,
      active,
    };
  }).filter(Boolean);
}

async function fetchProvider(provider, source) {
  if (provider === 'steam') return getSteamNews(source);
  if (provider === 'github') return getGitHubReleases(source);
  if (provider === 'rss') return getRssFeed(source);
  throw new Error(`Unsupported update provider: ${provider}`);
}

export async function getPatchSubscriptions(client, guildId) {
  const stored = await client.db?.get?.(key(guildId), []);
  return Array.isArray(stored) ? stored : [];
}

async function savePatchSubscriptions(client, guildId, subscriptions) {
  await client.db?.set?.(key(guildId), subscriptions);
}

function randomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export async function addPatchSubscription(client, {
  guildId,
  provider,
  source,
  discordChannelId,
  mentionRoleId = null,
  label = null,
}) {
  const subscriptions = await getPatchSubscriptions(client, guildId);
  if (subscriptions.length >= MAX_SUBSCRIPTIONS) {
    throw new Error(`This server already has ${MAX_SUBSCRIPTIONS} update subscriptions.`);
  }

  const feed = await fetchProvider(provider, source);
  const normalizedSource = feed.source;
  const existing = subscriptions.find(
    (entry) => entry.provider === provider && entry.source === normalizedSource
  );

  const subscription = {
    id: existing?.id || randomId(),
    provider,
    source: normalizedSource,
    label: String(label || feed.title || normalizedSource).slice(0, 100),
    discordChannelId,
    mentionRoleId,
    lastItemId: feed.items[0]?.id || existing?.lastItemId || null,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  if (existing) Object.assign(existing, subscription);
  else subscriptions.push(subscription);

  await savePatchSubscriptions(client, guildId, subscriptions);
  return subscription;
}

export async function removePatchSubscription(client, guildId, id) {
  const subscriptions = await getPatchSubscriptions(client, guildId);
  const normalized = String(id || '').trim().toUpperCase();
  const filtered = subscriptions.filter((entry) => String(entry.id).toUpperCase() !== normalized);
  if (filtered.length === subscriptions.length) return false;
  await savePatchSubscriptions(client, guildId, filtered);
  return true;
}

function updateEmbed(subscription, item) {
  const embed = new EmbedBuilder()
    .setTitle(String(item.title || subscription.label || 'New Update').slice(0, 256))
    .setDescription(String(item.description || 'A new update was published.').slice(0, 3500))
    .setFooter({ text: `${subscription.label} • ${subscription.provider.toUpperCase()}` })
    .setTimestamp(item.publishedAt ? new Date(item.publishedAt) : new Date());

  if (item.url) embed.setURL(item.url);
  return embed;
}

async function sendUpdate(client, guild, subscription, item) {
  const channel = guild.channels.cache.get(subscription.discordChannelId)
    || await guild.channels.fetch(subscription.discordChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) return false;

  const components = [];
  if (item.url?.startsWith('http')) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('View Update')
          .setStyle(ButtonStyle.Link)
          .setURL(item.url),
      ),
    );
  }

  await channel.send({
    content: subscription.mentionRoleId
      ? `<@&${subscription.mentionRoleId}> New update for **${subscription.label}**!`
      : `📰 New update for **${subscription.label}**!`,
    embeds: [updateEmbed(subscription, item)],
    components,
    allowedMentions: subscription.mentionRoleId ? { roles: [subscription.mentionRoleId] } : { parse: [] },
  });
  return true;
}

async function pollGuild(client, guild) {
  const subscriptions = await getPatchSubscriptions(client, guild.id);
  if (!subscriptions.length) return;

  let changed = false;
  for (const subscription of subscriptions) {
    try {
      const feed = await fetchProvider(subscription.provider, subscription.source);
      if (!feed.items.length) continue;

      const newest = feed.items[0];
      if (newest.id === subscription.lastItemId) continue;

      const oldIndex = feed.items.findIndex((item) => item.id === subscription.lastItemId);
      const unseen = oldIndex > 0
        ? feed.items.slice(0, oldIndex).reverse()
        : [newest];

      for (const item of unseen.slice(-5)) {
        await sendUpdate(client, guild, subscription, item);
      }

      subscription.lastItemId = newest.id;
      changed = true;
    } catch (error) {
      logger.warn(`Patch feed ${subscription.id} failed in ${guild.id}: ${error?.message || error}`);
    }
  }

  if (changed) await savePatchSubscriptions(client, guild.id, subscriptions);
}

async function pollAll(client) {
  for (const guild of client.guilds.cache.values()) {
    await pollGuild(client, guild).catch((error) =>
      logger.warn(`Patch feed poll failed in ${guild.id}: ${error?.message || error}`)
    );
  }
}

export function startPatchFeedMonitor(client) {
  if (client.patchFeedInterval) return;
  void pollAll(client);
  client.patchFeedInterval = setInterval(() => void pollAll(client), POLL_INTERVAL_MS);
  client.patchFeedInterval.unref?.();
  logger.info('Patch/update feed monitor started');
}

export async function getLatestPatch(provider, source) {
  const feed = await fetchProvider(provider, source);
  return { feed, item: feed.items[0] || null };
}

export async function testPatchSubscription(client, guild, subscription) {
  const feed = await fetchProvider(subscription.provider, subscription.source);
  const item = feed.items[0];
  if (!item) throw new Error('No update item was found for this subscription.');
  return sendUpdate(client, guild, subscription, item);
}
