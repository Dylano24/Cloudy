import { Events, ChannelType } from 'discord.js';
import {
  syncCloudyTicketMessage,
  syncCloudyTicketChannelName,
} from '../services/ticketUiService.js';
import { logger } from '../utils/logger.js';

const PERIODIC_TICKET_SYNC_MS = 5 * 60 * 1000;

function looksLikeTicketChannel(channel) {
  if (channel.type !== ChannelType.GuildText) return false;
  return /ticket-?\d+/i.test(String(channel.name || ''));
}

async function synchronizeTickets(client, reason = 'manual') {
  let checked = 0;
  let messageSynced = 0;
  let channelSynced = 0;

  for (const guild of client.guilds.cache.values()) {
    const channels = guild.channels.cache.filter(looksLikeTicketChannel);

    for (const channel of channels.values()) {
      checked += 1;

      try {
        const [messageUpdated, channelQueued] = await Promise.all([
          syncCloudyTicketMessage(channel),
          syncCloudyTicketChannelName(channel),
        ]);

        if (messageUpdated) messageSynced += 1;
        if (channelQueued) channelSynced += 1;
      } catch (error) {
        logger.warn('Ticket reconciliation failed for channel', {
          reason,
          guildId: guild.id,
          channelId: channel.id,
          error: error.message,
        });
      }
    }
  }

  logger.info('Ticket reconciliation completed', {
    reason,
    checked,
    messageSynced,
    channelSynced,
  });
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    // Allow PostgreSQL and Discord caches to finish warming up.
    await new Promise(resolve => setTimeout(resolve, 3000));
    await synchronizeTickets(client, 'startup');

    // A lightweight safety reconciliation keeps the visible ticket UI and the
    // channel-side priority emoji consistent with PostgreSQL for long-running
    // processes, even after a temporary Discord API/rate-limit failure.
    const timer = setInterval(() => {
      synchronizeTickets(client, 'periodic').catch(error => {
        logger.warn('Periodic ticket reconciliation failed', { error: error.message });
      });
    }, PERIODIC_TICKET_SYNC_MS);

    timer.unref?.();
  },
};
