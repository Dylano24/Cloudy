import { ChannelType, Events } from 'discord.js';
import { findTicketPanelMessage } from '../services/ticketDashboardService.js';
import { getGuildConfig, updateGuildConfig } from '../services/config/guildConfig.js';
import { recoverGuildTickets } from '../services/ticketReliabilityService.js';
import { getTicketData, saveTicketData } from '../utils/database.js';
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

async function reconcilePendingTicketDeletions(guild, summary) {
  const ticketChannels = [...guild.channels.cache.values()].filter(channel =>
    channel.type === ChannelType.GuildText
    && /ticket-\d+/i.test(String(channel.name || ''))
  );

  for (const channel of ticketChannels) {
    const ticketData = await getTicketData(guild.id, channel.id).catch(() => null);
    if (!ticketData?.deletionScheduledAt) continue;

    if (!ticketData.transcriptArchivedAt) {
      ticketData.deletionScheduledAt = null;
      ticketData.deletionScheduledBy = null;
      ticketData.deletionFailedAt = new Date().toISOString();
      ticketData.deletionFailure = 'Bot restarted before transcript archival completed; deletion was cancelled for safety.';
      await saveTicketData(guild.id, channel.id, ticketData).catch(() => {});
      summary.pendingDeletionReset += 1;

      logger.warn('Cancelled interrupted ticket deletion because transcript was not archived', {
        guildId: guild.id,
        channelId: channel.id,
      });
      continue;
    }

    try {
      await channel.delete('Resume interrupted ticket deletion after bot restart');
      summary.pendingDeletionRecovered += 1;
      logger.info('Recovered interrupted ticket deletion after restart', {
        guildId: guild.id,
        channelId: channel.id,
      });
    } catch (error) {
      if (String(ticketData.status || '').toLowerCase() === 'deleted') {
        ticketData.status = 'closed';
      }
      ticketData.deletionFailedAt = new Date().toISOString();
      ticketData.deletionFailure = error.message;
      await saveTicketData(guild.id, channel.id, ticketData).catch(() => {});

      logger.warn('Could not resume interrupted ticket deletion after restart', {
        guildId: guild.id,
        channelId: channel.id,
        error: error.message,
      });
    }
  }
}

async function recoverGuildTicketSystem(client, guild) {
  const summary = {
    panelUpdated: false,
    panelReposted: false,
    panelStyled: false,
    panelDisabled: false,
    panelManagedByRepostOnly: true,
    pendingDeletionRecovered: 0,
    pendingDeletionReset: 0,
    ticketsRecovered: 0,
  };

  const config = await getGuildConfig(client, guild.id);

  if (config?.ticketSystemDisabled === true) {
    await reconcileDisabledTicketPanel(client, guild, config, summary);
  } else {
    // Do not edit, recreate, style, or publish the ticket panel during startup.
    // The saved dashboard settings are applied only when an administrator
    // explicitly presses Repost Panel.
  }

  try {
    await reconcilePendingTicketDeletions(guild, summary);
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
