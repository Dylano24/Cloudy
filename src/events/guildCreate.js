import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig, setGuildConfig } from '../services/config/guildConfig.js';
import { registerCommands } from '../handlers/loaders/commandLoader.js';
import { repairGuild } from './cloudySelfReadPermissionsReady.js';

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
        // A re-invite triggers GuildCreate without ClientReady. Recover existing
        // channel read/post access without touching panels, roles or messages.
        if (guild.id === '1532882647838228723') {
          await repairGuild(client).catch(error => {
            logger.warn(`[CHANNEL_RECOVERY] Rejoin permission repair failed: ${error?.message || error}`);
          });
        }
      }
    } catch (error) {
      logger.error(`Error initializing guild ${guild?.id} on join:`, error);
    }
  },
};
