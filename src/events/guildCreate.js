import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig, setGuildConfig } from '../services/config/guildConfig.js';
import { registerGuildCommandsForGuild } from '../handlers/loaders/commandLoader.js';

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

      // Register the full Administrator/Owner command suite immediately in the
      // guild the bot just joined. This does not rely on Railway GUILD_ID or
      // CLIENT_ID values; the authenticated bot token determines the app ID.
      await registerGuildCommandsForGuild(client, guild.id, {
        clientId: client.user?.id,
      });

      logger.info(`Cloudy admin commands synced for newly joined guild ${guild.id}`);
    } catch (error) {
      logger.error(`Error initializing guild ${guild?.id} on join:`, error);
    }
  },
};
