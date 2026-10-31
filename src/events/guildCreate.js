import { spawn } from 'node:child_process';
import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig, setGuildConfig } from '../services/config/guildConfig.js';
import { registerCommands } from '../handlers/loaders/commandLoader.js';
import { repairGuild } from './cloudySelfReadPermissionsReady.js';

// A new server gets Cloudy's slash commands right away, through the same
// startup sync script (one server only, in a separate process).
function syncCommandsForNewGuild(guildId) {
  try {
    const child = spawn(process.execPath, ['scripts/register-cloudy-guild-commands.js'], {
      cwd: process.cwd(),
      env: { ...process.env, COMMAND_SYNC_ONLY_GUILD: String(guildId) },
      stdio: 'inherit',
    });
    child.on('error', error => logger.warn(`[COMMAND_SYNC] Could not sync guild ${guildId}: ${error.message}`));
    child.unref();
  } catch (error) {
    logger.warn(`[COMMAND_SYNC] Could not sync guild ${guildId}: ${error?.message || error}`);
  }
}

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
      } else {
        syncCommandsForNewGuild(guild.id);
      }
    } catch (error) {
      logger.error(`Error initializing guild ${guild?.id} on join:`, error);
    }
  },
};
