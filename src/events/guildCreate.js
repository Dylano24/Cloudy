import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig, setGuildConfig } from '../services/config/guildConfig.js';
import { registerCommands } from '../handlers/loaders/commandLoader.js';

export default {
  name: Events.GuildCreate,
  async execute(guild, client) {
    try {
      logger.info('Bot joined guild', {
        event: 'guild.create',
        guildId: guild.id,
        guildName: guild.name,
        memberCount: guild.memberCount,
      });

      const config = await getGuildConfig(client, guild.id);
      await setGuildConfig(client, guild.id, config);

      const configuredGuildId = String(process.env.GUILD_ID || '').trim();
      if (!configuredGuildId || guild.id === configuredGuildId) {
        await registerCommands(client);
        logger.info(`[COMMAND_SYNC] Slash commands synced after joining guild ${guild.id}`);
      }
    } catch (error) {
      logger.error(`Error initializing guild ${guild?.id} on join:`, error);
    }
  },
};
