import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { syncGuildCommandOverflowForAllGuilds } from '../services/guildCommandOverflowService.js';

const STARTUP_SYNC_DELAY_MS = 5000;

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      // The restored 06:00 app registers its original global command set just
      // after login. Wait briefly so the guild overflow sync always runs last
      // and cannot be partially cleaned up by that legacy registration pass.
      await new Promise((resolve) => setTimeout(resolve, STARTUP_SYNC_DELAY_MS));

      const summaries = await syncGuildCommandOverflowForAllGuilds(client);
      logger.info(`[COMMAND_OVERFLOW] Startup sync completed for ${summaries.length} guild(s)`);
    } catch (error) {
      logger.error('[COMMAND_OVERFLOW] Startup sync failed:', error);
    }
  },
};
