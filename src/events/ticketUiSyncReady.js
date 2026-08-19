import { Events, ChannelType } from 'discord.js';
import {
  syncCloudyTicketMessage,
  syncCloudyTicketChannelName,
} from '../services/ticketUiService.js';
import { logger } from '../utils/logger.js';

function looksLikeTicketChannel(channel) {
  if (channel.type !== ChannelType.GuildText) return false;
  return /ticket-?\d+/i.test(String(channel.name || ''));
}

async function synchronizeTickets(client) {
  let checked = 0;
  let messageSynced = 0;
  let channelSynced = 0;

  for (const guild of client.guilds.cache.values()) {
    const channels = guild.channels.cache.filter(looksLikeTicketChannel);

    for (const channel of channels.values()) {
      checked += 1;

      try {
        const messageUpdated = await syncCloudyTicketMessage(channel);
        const channelQueued = await syncCloudyTicketChannelName(channel);

        if (messageUpdated) messageSynced += 1;
        if (channelQueued) channelSynced += 1;
      } catch (error) {
        logger.warn('Startup ticket reconciliation failed for channel', {
          guildId: guild.id,
          channelId: channel.id,
          error: error.message,
        });
      }
    }
  }

  logger.info('Startup ticket reconciliation completed', {
    checked,
    messageSynced,
    channelSynced,
  });
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    // One startup repair is enough. Priority/channel-name retries are already
    // handled by the per-ticket queue. Running a full reconciliation every five
    // minutes caused unnecessary Discord REST traffic and could delay buttons.
    await new Promise(resolve => setTimeout(resolve, 2500));
    await synchronizeTickets(client);
  },
};
