import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    for (const guild of client.guilds.cache.values()) {
      const channels = [...guild.channels.cache.values()]
        .filter(channel => channel?.isTextBased?.())
        .map(channel => `${channel.id}:${channel.name}`)
        .join(' | ');
      logger.warn(`[EMBED_BUILDER_CHANNELS] ${channels}`);
    }
  },
};
