import { Events } from 'discord.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { normalizeTicketPanelMessage } from '../utils/ticket/ticketPanelAppearance.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    for (const guild of client.guilds.cache.values()) {
      try {
        const config = await getGuildConfig(client, guild.id);
        if (!config.ticketPanelChannelId) continue;

        const channel = await guild.channels.fetch(config.ticketPanelChannelId).catch(() => null);
        if (!channel?.isTextBased?.() || !channel.messages?.fetch) continue;

        let message = null;
        if (config.ticketPanelMessageId) {
          message = await channel.messages.fetch(config.ticketPanelMessageId).catch(() => null);
        }

        if (!message) {
          const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
          message = recent?.find(candidate =>
            candidate.author?.id === client.user.id
            && candidate.components
              ?.flatMap(row => row.components || [])
              .some(component => component.customId === 'create_ticket'),
          ) || null;
        }

        if (message) {
          await normalizeTicketPanelMessage(message);
        }
      } catch (error) {
        logger.warn('Could not refresh ticket panel appearance on ready', {
          guildId: guild.id,
          error: error.message,
        });
      }
    }
  },
};
