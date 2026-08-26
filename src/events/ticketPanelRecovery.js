import { Events } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../services/config/guildConfig.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageDelete,
  once: false,

  async execute(message, client) {
    if (!message?.guild?.id || !message?.id) return;
    if (message.author?.id && message.author.id !== client.user?.id) return;

    try {
      const config = await getGuildConfig(client, message.guild.id);
      if (!config?.ticketPanelChannelId || config.ticketPanelMessageId !== message.id) return;

      // Never recreate a deleted ticket panel automatically. The saved ticket
      // settings remain intact and the panel is only created again when an
      // administrator explicitly presses Repost Panel in the dashboard.
      await updateGuildConfig(client, message.guild.id, {
        ticketPanelMessageId: null,
      });

      logger.info('Ticket panel deletion recorded; waiting for explicit Repost Panel', {
        guildId: message.guild.id,
        deletedMessageId: message.id,
      });
    } catch (error) {
      logger.warn('Ticket panel deletion state update failed', {
        guildId: message.guild.id,
        messageId: message.id,
        error: error.message,
      });
    }
  },
};
