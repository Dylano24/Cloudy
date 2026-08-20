import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { syncGuildCommandOverflow } from '../services/guildCommandOverflowService.js';

export default {
  name: Events.GuildCreate,

  async execute(guild, client) {
    try {
      await syncGuildCommandOverflow(client, guild.id);
      logger.info(`[COMMAND_OVERFLOW] Synced commands after joining guild ${guild.id}`);
    } catch (error) {
      logger.error(`[COMMAND_OVERFLOW] Guild join sync failed for ${guild?.id}:`, error);
    }
  },
};
