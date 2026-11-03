import { Events } from 'discord.js';
import { cleanupDeletedGiveaways } from '../services/giveawayDeletedMessageSync.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageBulkDelete,
  once: false,
  async execute(messages) {
    const list = [...(messages?.values?.() || [])];
    const first = list.find(message => message?.client && (message.guildId || message.guild?.id));
    if (!first) return;
    const client = first.client;
    const guildId = first.guildId || first.guild.id;
    const entries = list.filter(message =>
      (message.guildId || message.guild?.id) === guildId
      && (!message.author?.id || !client.user?.id || message.author.id === client.user.id))
      .map(message => ({
        messageId: message.id,
        channelId: message.channelId || message.channel?.id,
      }));
    if (!entries.length) return;
    await cleanupDeletedGiveaways(client, guildId, { entries })
      .catch(error => logger.warn('Could not sync bulk-deleted giveaway messages in ' + guildId, error));
  },
};
