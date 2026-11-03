import { Events } from 'discord.js';
import { cleanupDeletedGiveaways } from '../services/giveawayDeletedMessageSync.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageDelete,
  once: false,
  async execute(message) {
    const client = message?.client;
    const guildId = message?.guildId || message?.guild?.id;
    const channelId = message?.channelId || message?.channel?.id;
    if (!client || !guildId || !channelId || !message?.id) return;
    if (message.author?.id && client.user?.id && message.author.id !== client.user.id) return;
    await cleanupDeletedGiveaways(client, guildId, {
      entries: [{ messageId: message.id, channelId }],
    }).catch(error => logger.warn('Could not sync deleted giveaway message ' + message.id, error));
  },
};
