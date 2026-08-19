import { Events } from 'discord.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import {
  applyTicketPanelPresentation,
  isTicketPanelMessage,
} from '../services/ticketPanelPresentation.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    for (const guild of client.guilds.cache.values()) {
      try {
        const config = await getGuildConfig(client, guild.id);
        if (!config?.ticketPanelChannelId) continue;

        const channel = await guild.channels.fetch(config.ticketPanelChannelId).catch(() => null);
        if (!channel?.isTextBased?.() || !channel.messages?.fetch) continue;

        let panelMessage = null;

        if (config.ticketPanelMessageId) {
          panelMessage = await channel.messages.fetch(config.ticketPanelMessageId).catch(() => null);
        }

        if (!panelMessage || !isTicketPanelMessage(panelMessage)) {
          const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
          panelMessage = messages?.find(message =>
            message.author?.id === client.user.id && isTicketPanelMessage(message)
          ) || null;
        }

        if (panelMessage) {
          await applyTicketPanelPresentation(panelMessage);
        }
      } catch (error) {
        logger.warn('Could not restore ticket panel presentation on startup', {
          guildId: guild.id,
          error: error.message,
        });
      }
    }
  },
};
