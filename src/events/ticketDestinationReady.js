import { Events } from 'discord.js';
import { ensureTicketDestinationConfig } from '../services/ticketDestinationAutoConfig.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    for (const guild of client.guilds.cache.values()) {
      try {
        await ensureTicketDestinationConfig(client, guild, { refreshIfMissing: true });
      } catch (error) {
        logger.warn('Ticket destination startup recovery failed', {
          guildId: guild.id,
          error: error.message,
        });
      }
    }
  },
};
