import { Events } from 'discord.js';
import {
  registerCloudyEmbedMessage,
  removeEmbedRegistryMessage,
} from '../services/embedRegistryService.js';
import { logger } from '../utils/logger.js';

const CATALOG_CONTENT = 'System & error embed templates';
const CLEANUP_DELAY_MS = 5000;
const CATALOG_CHANNEL_NAMES = new Set(['botlog', 'cloudy-response-catalog-loading']);

function normalize(value) {
  return String(value || '')
    .replace(/<t:\d+(?::[tTdDfFR])?>|<@!?\d+>|<@&\d+>|<#\d+>|<a?:[^:>]+:\d+>|https?:\/\/\S+|[$€£][\d,.]+|\b\d{1,3}(?:\.\d+)?%\b|\b\d{17,20}\b|\b\d+(?:\.\d+)?\b/gi, '{dynamic}')
    .replace(/\s*[—–-]\s*/g, ' — ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function metadataContext(embed) {
  const data = embed?.toJSON ? embed.toJSON() : (embed || {});
  const author = String(data.author?.name || '');
  const match = author.match(/Cloudy\s+context:\s*([^|]+)/i);
  return normalize(match?.[1] || '').split('/')[0] || 'global';
}

function isSlotsEmbed(embed) {
  const data = embed?.toJSON ? embed.toJSON() : (embed || {});
  const text = [data.author?.name, data.title, data.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /(?:^|[\s/:|_-])slots?(?:$|[\s/:|_-])/.test(text);
}

function catalogIdentity(embed) {
  const data = embed?.toJSON ? embed.toJSON() : (embed || {});
  const author = String(data.author?.name || '');
  const stableKey = author.match(/^Cloudy\s+template\s+key:\s*([^|]+)/i)?.[1]?.trim().toLowerCase() || '';
  const context = metadataContext(embed);

  if (stableKey) return `${context}::system:${stableKey}`;

  const title = normalize(data.title || '');
  const fieldNames = (data.fields || []).map(field => normalize(field?.name || '')).join('|');
  const description = normalize(data.description || '');
  if (title) return `${context}::${title}`;
  return `${context}::${fieldNames}::${description}`;
}

async function refreshChangedCatalogMessage(guild, message) {
  // Removing by the physical catalog channel also removes virtual registry rows
  // whose display channel points at gambling/tickets/etc. Re-registering the
  // edited message then recreates only the embeds that still exist.
  await removeEmbedRegistryMessage(guild.id, message.channelId, message.id).catch(error => {
    logger.warn(`[EMBED_BUILDER] Could not remove stale catalog registry rows: ${error?.message || error}`);
  });
  await registerCloudyEmbedMessage(message, 'system-catalog').catch(error => {
    logger.warn(`[EMBED_BUILDER] Could not refresh cleaned catalog registry rows: ${error?.message || error}`);
  });
}

async function cleanupGuild(guild, clientUserId) {
  const catalogMessages = [];
  const catalogChannels = [...guild.channels.cache.values()].filter(channel =>
    channel?.isTextBased?.()
    && channel?.messages?.fetch
    && CATALOG_CHANNEL_NAMES.has(String(channel.name || '').toLowerCase()),
  );

  for (const channel of catalogChannels) {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages) continue;
    for (const message of messages.values()) {
      if (message.author?.id !== clientUserId) continue;
      if (String(message.content || '').trim() !== CATALOG_CONTENT) continue;
      catalogMessages.push(message);
    }
  }

  catalogMessages.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  const seen = new Set();
  let removed = 0;
  let slotsRemoved = 0;
  let refreshedMessages = 0;

  for (const message of catalogMessages) {
    const kept = [];
    let changed = false;

    for (const embed of message.embeds || []) {
      if (isSlotsEmbed(embed)) {
        slotsRemoved += 1;
        removed += 1;
        changed = true;
        continue;
      }

      const identity = catalogIdentity(embed);
      if (seen.has(identity)) {
        removed += 1;
        changed = true;
        continue;
      }

      seen.add(identity);
      kept.push(embed);
    }

    if (!changed) continue;

    const edited = await message.edit({ content: CATALOG_CONTENT, embeds: kept }).catch(error => {
      logger.warn(`[EMBED_BUILDER] Catalog duplicate cleanup edit failed: ${error?.message || error}`);
      return null;
    });
    if (!edited) continue;

    await refreshChangedCatalogMessage(guild, edited);
    refreshedMessages += 1;
  }

  return {
    removed,
    slotsRemoved,
    catalogChannels: catalogChannels.length,
    refreshedMessages,
  };
}

export default {
  name: Events.ClientReady,
  once: true,

  execute(client) {
    const timer = setTimeout(() => {
      void (async () => {
        let removed = 0;
        let slotsRemoved = 0;
        let catalogChannels = 0;
        let refreshedMessages = 0;
        for (const guild of client.guilds.cache.values()) {
          const result = await cleanupGuild(guild, client.user.id);
          removed += result.removed;
          slotsRemoved += result.slotsRemoved;
          catalogChannels += result.catalogChannels;
          refreshedMessages += result.refreshedMessages;
        }
        logger.warn(`[EMBED_BUILDER] Catalog cleanup complete: ${removed} duplicate/retired entries removed (${slotsRemoved} slots) across ${catalogChannels} catalog channel(s); ${refreshedMessages} changed catalog message(s) refreshed in registry.`);
      })().catch(error => {
        logger.warn(`[EMBED_BUILDER] Catalog cleanup failed: ${error?.message || error}`);
      });
    }, CLEANUP_DELAY_MS);
    timer.unref?.();
  },
};
