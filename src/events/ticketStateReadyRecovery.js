import { Events } from 'discord.js';
import { recoverGuildTickets } from '../services/ticketReliabilityService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      for (const guild of client.guilds.cache.values()) {
        try {
          const recovered = await recoverGuildTickets(guild);
          if (recovered > 0) {
            logger.info('Recovered persistent ticket state after startup', {
              guildId: guild.id,
              tickets: recovered,
            });
          }
        } catch (error) {
          if (error?.code !== 'TICKET_DATABASE_UNAVAILABLE') {
            logger.warn('Ticket startup recovery skipped/failed', {
              guildId: guild.id,
              error: error.message,
            });
          }
        }
      }
    }, 1500);

    timer.unref?.();
  },
};
