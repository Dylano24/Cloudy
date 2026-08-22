import { Events } from 'discord.js';
import {
  findTicketPanelMessage,
  repostTicketPanel,
  updateLiveTicketPanel,
} from '../services/ticketDashboardService.js';
import { applyTicketPanelPresentation } from '../services/ticketPanelPresentation.js';
import { getGuildConfig, updateGuildConfig } from '../services/config/guildConfig.js';
import { recoverGuildTickets } from '../services/ticketReliabilityService.js';
import { logger } from '../utils/logger.js';

const STARTUP_DELAY_MS = 1800;

async function reconcileDisabledTicketPanel(client, guild, config, summary) {
  summary.panelDisabled = true;

  if (!config?.ticketPanelChannelId) return;

  try {
    const stalePanel = await findTicketPanelMessage(client, guild, config).catch(() => null);
    if (!stalePanel) {
      if (config.ticketPanelMessageId) {
        await updateGuildConfig(client, guild.id, { ticketPanelMessageId: null });
      }
      return;
    }

    await stalePanel.delete();
    await updateGuildConfig(client, guild.id, { ticketPanelMessageId: null });

    logger.info('Removed stale ticket panel while ticket system is disabled', {
      guildId: guild.id,
      messageId: stalePanel.id,
    });
  } catch (error) {
    logger.warn('Could not fully reconcile disabled ticket panel state', {
      guildId: guild.id,
      error: error.message,
    });
  }
}

async function recoverGuildTicketSystem(client, guild) {
  const summary = {
    panelUpdated: false,
    panelReposted: false,
    panelStyled: false,
    panelDisabled: false,
    ticketsRecovered: 0,
  };

  const config = await getGuildConfig(client, guild.id);

  if (config?.ticketSystemDisabled === true) {
    await reconcileDisabledTicketPanel(client, guild, config, summary);
  } else if (config?.ticketPanelChannelId) {
    try {
      summary.panelUpdated = await updateLiveTicketPanel(client, guild, config);

      if (!summary.panelUpdated) {
        const recovered = await repostTicketPanel(client, guild);
        summary.panelReposted = Boolean(recovered?.panel);
      }

      const latestConfig = await getGuildConfig(client, guild.id);
      const panel = await findTicketPanelMessage(client, guild, latestConfig).catch(() => null);
      if (panel) {
        summary.panelStyled = await applyTicketPanelPresentation(panel);
      }
    } catch (error) {
      logger.warn('Ticket panel startup recovery failed', {
        guildId: guild.id,
        error: error.message,
      });
    }
  }

  try {
    summary.ticketsRecovered = await recoverGuildTickets(guild);
  } catch (error) {
    if (error?.code !== 'TICKET_DATABASE_UNAVAILABLE') {
      logger.warn('Ticket state startup recovery failed', {
        guildId: guild.id,
        error: error.message,
      });
    }
  }

  return summary;
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      for (const guild of client.guilds.cache.values()) {
        try {
          const summary = await recoverGuildTicketSystem(client, guild);
          logger.info('Ticket system startup recovery completed', {
            guildId: guild.id,
            ...summary,
          });
        } catch (error) {
          logger.warn('Ticket system startup recovery failed unexpectedly', {
            guildId: guild.id,
            error: error.message,
          });
        }
      }
    }, STARTUP_DELAY_MS);

    timer.unref?.();
  },
};