import { Events } from 'discord.js';
import { getFromDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const REGISTRY_PREFIX = 'cloudy:embed-registry:';
const CATALOG_PREFIX = 'cloudy:system-embed-catalog:';
const TEMPLATE_PREFIX = 'Cloudy template key:';

function parseTemplateMetadata(embed) {
  const data = embed?.toJSON ? embed.toJSON() : (embed || {});
  const authorName = String(data.author?.name || '');
  if (!authorName.toLowerCase().startsWith(TEMPLATE_PREFIX.toLowerCase())) {
    return { key: '', context: '', title: String(data.title || '') };
  }

  const payload = authorName.slice(TEMPLATE_PREFIX.length).trim();
  const contextMatch = payload.match(/\|\|\s*Cloudy context:\s*([^|]+)/i);
  const key = payload.split(/\s+\|\|\s+Cloudy\s+(?:context|kind):/i)[0].trim();
  return {
    key,
    context: String(contextMatch?.[1] || '').trim(),
    title: String(data.title || ''),
  };
}

async function inspectGuild(guild) {
  const registry = await getFromDb(`${REGISTRY_PREFIX}${guild.id}`, []);
  const catalogIds = await getFromDb(`${CATALOG_PREFIX}${guild.id}`, []);
  const records = Array.isArray(registry) ? registry : [];
  const ids = Array.isArray(catalogIds) ? catalogIds : [];
  const catalogRecords = records.filter(record => String(record?.source || '') === 'system-catalog');
  const physicalGroups = new Map();

  for (const record of catalogRecords) {
    const channelId = String(record?.backingChannelId || record?.channelId || '');
    const messageId = String(record?.messageId || '');
    if (!channelId || !messageId) continue;
    const key = `${channelId}:${messageId}`;
    if (!physicalGroups.has(key)) physicalGroups.set(key, { channelId, messageId, records: [] });
    physicalGroups.get(key).records.push(record);
  }

  const gameTemplates = [];
  const missingMessages = [];

  for (const group of physicalGroups.values()) {
    const channel = guild.channels.cache.get(group.channelId)
      || await guild.channels.fetch(group.channelId).catch(() => null);
    if (!channel?.messages?.fetch) {
      missingMessages.push(`${group.channelId}:${group.messageId}`);
      continue;
    }

    const message = await channel.messages.fetch(group.messageId).catch(() => null);
    if (!message) {
      missingMessages.push(`${group.channelId}:${group.messageId}`);
      continue;
    }

    for (const record of group.records) {
      const embed = message.embeds?.[Number(record.embedIndex || 0)] || null;
      if (!embed) continue;
      const metadata = parseTemplateMetadata(embed);
      if (/^gambling(?:\/|$)/i.test(metadata.context) || /^game:/i.test(metadata.key)) {
        gameTemplates.push({
          key: metadata.key,
          context: metadata.context,
          title: metadata.title,
          displayChannelId: String(record.channelId || ''),
          backingChannelId: group.channelId,
          messageId: group.messageId,
          embedIndex: Number(record.embedIndex || 0),
        });
      }
    }
  }

  logger.warn(`[GAMING_CATALOG_DIAGNOSTIC] guild=${guild.id} registry=${records.length} systemCatalogRecords=${catalogRecords.length} catalogIds=${ids.length} physicalCatalogMessages=${physicalGroups.size} missingPhysicalMessages=${missingMessages.length} gameTemplates=${gameTemplates.length}`);
  logger.warn(`[GAMING_CATALOG_DIAGNOSTIC] gameTemplates=${JSON.stringify(gameTemplates)}`);
  if (missingMessages.length) {
    logger.warn(`[GAMING_CATALOG_DIAGNOSTIC] missingMessages=${JSON.stringify(missingMessages.slice(0, 50))}`);
  }
}

export default {
  name: Events.ClientReady,
  once: true,

  execute(client) {
    const timer = setTimeout(() => {
      for (const guild of client.guilds.cache.values()) {
        void inspectGuild(guild).catch(error => {
          logger.warn(`[GAMING_CATALOG_DIAGNOSTIC] failed for ${guild.id}: ${error?.message || error}`);
        });
      }
    }, 8000);
    timer.unref?.();
  },
};
