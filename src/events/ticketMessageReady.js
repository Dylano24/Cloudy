import { ChannelType, Events } from 'discord.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { syncCloudyTicketMessage } from '../services/ticketUiService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    for (const guild of client.guilds.cache.values()) {
      try {
        const config = await getGuildConfig(client, guild.id);
        const ticketCategoryIds = new Set([
          config?.ticketCategoryId,
          config?.ticketClosedCategoryId,
        ].filter(Boolean));

        const ticketChannels = guild.channels.cache.filter(channel =>
          channel.type === ChannelType.GuildText
          && (
            ticketCategoryIds.has(channel.parentId)
            || /^(?:📌\s*)?(?:🚨\s*|🔴\s*|🟡\s*|🟢\s*|⚪\s*)?ticket-\d+/i.test(channel.name)
          )
        );

        for (const channel of ticketChannels.values()) {
          await syncCloudyTicketMessage(channel);
        }
      } catch (error) {
        logger.warn('Could not synchronize existing ticket messages on startup', {
          guildId: guild.id,
          error: error.message,
        });
      }
    }
  },
};
