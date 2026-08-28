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

function getUrlKind(value, contentType = '') {
  const url = String(value || '').toLowerCase();
  const type = normalize(contentType);

  if (type.startsWith('video/') || /\.(?:mp4|mov|m4v|webm|mkv|avi|3gp|3g2|mts|m2ts|hevc)(?:\?|$)/i.test(url)) {
    return 'video';
  }
  if (type.startsWith('image/') || /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(url) || isGifUrl(url)) {
    return isGifUrl(url) || type === 'image/gif' ? 'gif' : 'image';
  }
  return null;
}

function getMessageMedia(message, allowedKinds) {
  const media = [];

  for (const attachment of message.attachments?.values?.() || []) {
    const kind = getUrlKind(attachment.url, attachment.contentType);
    if (!kind || !allowedKinds.has(kind)) continue;
    media.push({
      url: attachment.url,
      name: attachment.name || `discord-${kind}`,
      kind,
      sourceText: `${attachment.name || ''} ${message.content || ''}`,
    });
  }

  for (const embed of message.embeds || []) {
    const candidates = [
      { url: embed.image?.url, kind: getUrlKind(embed.image?.url) },
      { url: embed.thumbnail?.url, kind: getUrlKind(embed.thumbnail?.url) },
      { url: embed.video?.url, kind: 'video' },
      { url: embed.url, kind: getUrlKind(embed.url) },
    ];

    for (const candidate of candidates) {
      if (!candidate.url || !candidate.kind || !allowedKinds.has(candidate.kind)) continue;
      media.push({
        url: candidate.url,
        name: `discord-${candidate.kind}`,
        kind: candidate.kind,
        sourceText: `${embed.title || ''} ${embed.description || ''} ${message.content || ''}`,
      });
    }
  }

  const contentUrls = String(message.content || '').match(/https?:\/\/\S+/g) || [];
  for (const rawUrl of contentUrls) {
    const url = rawUrl.replace(/[)>.,]+$/, '');
    const kind = getUrlKind(url);
    if (!kind || !allowedKinds.has(kind)) continue;
    media.push({
      url,
      name: `discord-${kind}`,
      kind,
      sourceText: message.content || '',
    });
  }

  return media;
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

export async function searchDiscordMedia(client, query, options = {}) {
  const wanted = normalize(query).trim();
  const preferredGuildId = options.preferredGuildId || null;
  const guildId = options.guildId || null;
  const allowedKinds = new Set(options.kinds?.length ? options.kinds : ['image', 'gif', 'video']);

  const guilds = [...client.guilds.cache.values()]
    .filter(guild => !guildId || guild.id === guildId)
    .sort((a, b) => {
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
      for (const entry of getMessageMedia(message, allowedKinds)) {
        const haystack = normalize([
          entry.sourceText,
          guild.name,
          channel.name,
          message.author?.username,
          message.author?.globalName,
        ].filter(Boolean).join(' '));

        if (wanted && !haystack.includes(wanted)) continue;

        matches.push({
          url: entry.url,
          name: entry.name,
          kind: entry.kind,
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

export async function searchDiscordGifs(client, query, options = {}) {
  return searchDiscordMedia(client, query, {
    ...options,
    kinds: ['gif'],
  });
}
