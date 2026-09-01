import { Events } from 'discord.js';
import { reconcileEmbedRegistry } from '../services/embedRegistryService.js';
import { logger } from '../utils/logger.js';

const CATALOG_CONTENT = 'System & error embed templates';
const CLEANUP_DELAY_MS = 9000;

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

  // Prefer the hidden stable system key. A visible title can be completely
  // renamed in the Builder and must not create a second logical template.
  if (stableKey) return `${context}::system:${stableKey}`;

  const title = normalize(data.title || '');
  const fieldNames = (data.fields || []).map(field => normalize(field?.name || '')).join('|');
  const description = normalize(data.description || '');
  if (title) return `${context}::${title}`;
  return `${context}::${fieldNames}::${description}`;
}

async function cleanupGuild(guild, clientUserId) {
  const catalogMessages = [];
  for (const channel of guild.channels.cache.values()) {
    if (!channel?.isTextBased?.() || !channel?.messages?.fetch) continue;
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

    if (changed) {
      await message.edit({ content: CATALOG_CONTENT, embeds: kept }).catch(error => {
        logger.warn(`[EMBED_BUILDER] Catalog duplicate cleanup edit failed: ${error?.message || error}`);
      });
    }
  }

  // Cleanup changes physical embed indices/counts. Reconcile immediately so
  // the manager never shows an old raw registry count (for example 102) while
  // its channel views already show the cleaned logical count (for example 59).
  const reconciliation = await reconcileEmbedRegistry(guild).catch(error => {
    logger.warn(`[EMBED_BUILDER] Registry reconcile after catalog cleanup failed: ${error?.message || error}`);
    return null;
  });

  return {
    removed,
    slotsRemoved,
    registryCount: reconciliation?.records?.length ?? null,
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
        let registryCount = 0;
        for (const guild of client.guilds.cache.values()) {
          const result = await cleanupGuild(guild, client.user.id);
          removed += result.removed;
          slotsRemoved += result.slotsRemoved;
          if (Number.isInteger(result.registryCount)) registryCount += result.registryCount;
        }
        logger.warn(`[EMBED_BUILDER] Catalog cleanup complete: ${removed} duplicate/retired entries removed (${slotsRemoved} slots); registry reconciled to ${registryCount} physical record(s).`);
      })().catch(error => {
        logger.warn(`[EMBED_BUILDER] Catalog cleanup failed: ${error?.message || error}`);
      });
    }, CLEANUP_DELAY_MS);
    timer.unref?.();
  },
};
