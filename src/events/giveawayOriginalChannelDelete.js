import { Events } from 'discord.js';
import { cleanupDeletedGiveaways } from '../services/giveawayDeletedMessageSync.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ChannelDelete,
  once: false,
  async execute(channel, client) {
    const guildId = channel?.guildId || channel?.guild?.id;
    const activeClient = client || channel?.client;
    if (!activeClient || !guildId || !channel?.id) return;
    await cleanupDeletedGiveaways(activeClient, guildId, { deletedChannelId: channel.id })
      .catch(error => logger.warn('Could not sync giveaways removed with channel ' + channel.id, error));
  },
};
