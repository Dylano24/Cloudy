import { Events } from 'discord.js';
import { removeEmbedRegistryMessage } from '../services/embedRegistryService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageBulkDelete,
  once: false,

  async execute(messages) {
    const removals = [];

    for (const message of messages?.values?.() || []) {
      const guildId = message.guildId || message.guild?.id;
      const channelId = message.channelId || message.channel?.id;
      if (!guildId || !channelId || !message.id) continue;
      if (!message.partial && message.author && message.author.id !== message.client.user?.id) continue;
      removals.push(removeEmbedRegistryMessage(guildId, channelId, message.id));
    }

    const results = await Promise.allSettled(removals);
    const failed = results.filter(result => result.status === 'rejected');
    if (failed.length) {
      logger.warn(`Failed to remove ${failed.length} bulk-deleted message(s) from the embed registry.`);
    }
  },
};
