import { Events } from 'discord.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { repostTicketPanel } from '../services/ticketDashboardService.js';
import { logger } from '../utils/logger.js';

const RECOVERY_DELAY_MS = 750;

export default {
  name: Events.MessageDelete,
  once: false,

  async execute(message, client) {
    if (!message?.guild?.id || !message?.id) return;
    if (message.author?.id && message.author.id !== client.user?.id) return;

    try {
      const config = await getGuildConfig(client, message.guild.id);
      if (!config?.ticketPanelChannelId || config.ticketPanelMessageId !== message.id) return;

      const timer = setTimeout(async () => {
        try {
          const latest = await getGuildConfig(client, message.guild.id);
          if (!latest?.ticketPanelChannelId || latest.ticketPanelMessageId !== message.id) return;

          const { panel } = await repostTicketPanel(client, message.guild);
          logger.info('Recovered deleted ticket panel automatically', {
            guildId: message.guild.id,
            deletedMessageId: message.id,
            newMessageId: panel.id,
          });
        } catch (error) {
          logger.warn('Could not recover deleted ticket panel automatically', {
            guildId: message.guild.id,
            deletedMessageId: message.id,
            error: error.message,
          });
        }
      }, RECOVERY_DELAY_MS);

      timer.unref?.();
    } catch (error) {
      logger.warn('Ticket panel deletion recovery check failed', {
        guildId: message.guild.id,
        messageId: message.id,
        error: error.message,
      });
    }
  },
};
