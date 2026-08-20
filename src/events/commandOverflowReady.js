import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { syncGuildCommandOverflowForAllGuilds } from '../services/guildCommandOverflowService.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      const summaries = await syncGuildCommandOverflowForAllGuilds(client);
      logger.info(`[COMMAND_OVERFLOW] Startup sync completed for ${summaries.length} guild(s)`);
    } catch (error) {
      logger.error('[COMMAND_OVERFLOW] Startup sync failed:', error);
    }
  },
};
