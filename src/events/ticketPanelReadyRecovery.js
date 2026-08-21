import { Events } from 'discord.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import {
  repostTicketPanel,
  updateLiveTicketPanel,
} from '../services/ticketDashboardService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    for (const guild of client.guilds.cache.values()) {
      try {
        const config = await getGuildConfig(client, guild.id);
        if (!config?.ticketPanelChannelId) continue;

        const updated = await updateLiveTicketPanel(client, guild, config).catch(() => false);
        if (updated) continue;

        const { panel } = await repostTicketPanel(client, guild);
        logger.info('Recovered missing ticket panel on startup', {
          guildId: guild.id,
          panelMessageId: panel.id,
        });
      } catch (error) {
        logger.warn('Ticket panel startup recovery failed', {
          guildId: guild.id,
          error: error.message,
        });
      }
    }
  },
};
