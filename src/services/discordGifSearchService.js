import { PermissionFlagsBits } from 'discord.js';

const MAX_CHANNELS = 60;
const MESSAGES_PER_CHANNEL = 40;
const MAX_RESULTS = 25;
const CONCURRENCY = 6;

function normalize(value) {
  return String(value || '').toLowerCase();
}

function isGifUrl(value) {
  const url = String(value || '');
  if (!url) return false;
  return /\.gif(?:\?|$)/i.test(url) || /media\.tenor\.com\//i.test(url) || /media\d*\.giphy\.com\//i.test(url);
}

function getMessageGifUrls(message) {
  const urls = [];

  for (const attachment of message.attachments?.values?.() || []) {
    const contentType = normalize(attachment.contentType);
    if (contentType === 'image/gif' || isGifUrl(attachment.url)) {
      urls.push({
        url: attachment.url,
        name: attachment.name || 'discord-gif.gif',
        sourceText: `${attachment.name || ''} ${message.content || ''}`,
      });
    }
  }

  for (const embed of message.embeds || []) {
    const candidates = [
      embed.image?.url,
      embed.thumbnail?.url,
      embed.video?.url,
      embed.url,
    ].filter(Boolean);

    for (const url of candidates) {
      if (!isGifUrl(url)) continue;
      urls.push({
        url,
        name: 'discord-gif.gif',
        sourceText: `${embed.title || ''} ${embed.description || ''} ${message.content || ''}`,
      });
    }
  }

  const contentUrls = String(message.content || '').match(/https?:\/\/\S+/g) || [];
  for (const rawUrl of contentUrls) {
    const url = rawUrl.replace(/[)>.,]+$/, '');
    if (!isGifUrl(url)) continue;
    urls.push({
      url,
      name: 'discord-gif.gif',
      sourceText: message.content || '',
    });
  }

  return urls;
}

function canReadChannel(guild, channel) {
  if (!channel?.isTextBased?.() || channel.isThread?.()) return false;
  if (!channel.messages?.fetch) return false;

  const me = guild.members.me;
  if (!me) return false;

  const permissions = channel.permissionsFor(me);
  return Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel) &&
    permissions?.has(PermissionFlagsBits.ReadMessageHistory),
  );
}

async function mapWithConcurrency(items, limit, worker) {
  const results = [];
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const value = await worker(items[index], index).catch(() => null);
      if (value) results.push(value);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

export async function searchDiscordGifs(client, query, options = {}) {
  const wanted = normalize(query).trim();
  const preferredGuildId = options.preferredGuildId || null;
  const guilds = [...client.guilds.cache.values()].sort((a, b) => {
    if (a.id === preferredGuildId) return -1;
    if (b.id === preferredGuildId) return 1;
    return a.name.localeCompare(b.name);
  });

  const channels = [];
  for (const guild of guilds) {
    await guild.channels.fetch().catch(() => null);
    for (const channel of guild.channels.cache.values()) {
      if (canReadChannel(guild, channel)) {
        channels.push({ guild, channel });
        if (channels.length >= MAX_CHANNELS) break;
      }
    }
    if (channels.length >= MAX_CHANNELS) break;
  }

  const perChannel = await mapWithConcurrency(channels, CONCURRENCY, async ({ guild, channel }) => {
    const messages = await channel.messages.fetch({ limit: MESSAGES_PER_CHANNEL }).catch(() => null);
    if (!messages) return [];

    const matches = [];
    for (const message of messages.values()) {
      for (const gif of getMessageGifUrls(message)) {
        const haystack = normalize([
          gif.sourceText,
          guild.name,
          channel.name,
          message.author?.username,
          message.author?.globalName,
        ].filter(Boolean).join(' '));

        if (wanted && !haystack.includes(wanted)) continue;

        matches.push({
          url: gif.url,
          name: gif.name,
          guildId: guild.id,
          guildName: guild.name,
          channelId: channel.id,
          channelName: channel.name,
          authorName: message.author?.globalName || message.author?.username || 'Unknown',
          messageId: message.id,
          createdTimestamp: message.createdTimestamp || 0,
        });
      }
    }
    return matches;
  });

  const seen = new Set();
  return perChannel
    .flat()
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
    .filter((entry) => {
      if (!entry?.url || seen.has(entry.url)) return false;
      seen.add(entry.url);
      return true;
    })
    .slice(0, MAX_RESULTS);
}
