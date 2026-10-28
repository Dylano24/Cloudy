import { logDeletedMessage } from './messageDelete.js';
import { Events } from 'discord.js';
import { removeEmbedRegistryMessage } from '../services/embedRegistryService.js';
import { logger } from '../utils/logger.js';
import { removeSystemEmbedCatalogMessage } from '../services/systemEmbedCatalogService.js';
import { resolveBulkDeletion } from '../services/deletionAttributionService.js';
import { getMessageSnapshot } from '../services/messageSnapshotService.js';

export default {
  name: Events.MessageBulkDelete,
  once: false,

  async execute(messages) {
    const detectedAt = Date.now();
    const removals = [];
    const list = [...(messages?.values?.() || [])];

    for (const message of list) {
      const guildId = message.guildId || message.guild?.id;
      const channelId = message.channelId || message.channel?.id;
      if (!guildId || !channelId || !message.id) continue;
      if (!message.partial && message.author && message.author.id !== message.client.user?.id) continue;
      removals.push(Promise.all([
        removeEmbedRegistryMessage(guildId, channelId, message.id),
        removeSystemEmbedCatalogMessage(guildId, channelId, message.id),
      ]));
    }

    const logging = (async () => {
      const sample = list.find(message => message?.guild);
      if (!sample) return;
      // Uncached messages: read their stored copies once, in parallel.
      const snapshots = new Map(await Promise.all(list.map(async message => [message.id,
        message.partial || !message.author ? await getMessageSnapshot(sample.guild.id, message.id) : null])));
      // One audit lookup for the whole bulk deletion, not one per message.
      const deleterFor = await resolveBulkDeletion(sample, list, {
        detectedAt,
        authorIdFor: message => message?.author?.id || snapshots.get(message?.id)?.authorId || null,
      });
      for (const message of list) {
        await logDeletedMessage(message, {
          bulk: true,
          detectedAt,
          deletedBy: deleterFor(message),
          snapshot: snapshots.get(message.id) ?? null,
        }).catch(error => logger.warn(`Failed to log bulk-deleted message ${message.id}:`, error));
      }
    })().catch(error => logger.warn('Failed to log bulk deletion:', error));

    const results = await Promise.allSettled(removals);
    await logging;
    const failed = results.filter(result => result.status === 'rejected');
    if (failed.length) {
      logger.warn(`Failed to remove ${failed.length} bulk-deleted message(s) from the embed registry.`);
    }
  },
};
