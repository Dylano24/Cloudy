import { Events, ChannelType } from 'discord.js';
import { syncCloudyTicketMessage } from '../services/ticketUiService.js';
import { logger } from '../utils/logger.js';

function looksLikeTicketChannel(channel) {
  if (channel.type !== ChannelType.GuildText) return false;
  const name = String(channel.name || '').toLowerCase();
  return /(?:^|\s|-)ticket-?\d+/.test(name) || name.startsWith('ticket-');
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    // Let the database and guild caches finish warming up first.
    await new Promise(resolve => setTimeout(resolve, 3000));

    let checked = 0;
    let synced = 0;

    for (const guild of client.guilds.cache.values()) {
      const channels = guild.channels.cache.filter(looksLikeTicketChannel);

      for (const channel of channels.values()) {
        checked += 1;
        try {
          const updated = await syncCloudyTicketMessage(channel);
          if (updated) synced += 1;
        } catch (error) {
          logger.warn('Startup ticket UI sync failed for channel', {
            guildId: guild.id,
            channelId: channel.id,
            error: error.message,
          });
        }
      }
    }

    logger.info('Startup ticket UI sync completed', { checked, synced });
  },
};
