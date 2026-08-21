import { Events } from 'discord.js';
import { getTicketData, saveTicketData } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const PIN_EMOJI = '📌';

export default {
  name: Events.ChannelUpdate,

  async execute(oldChannel, newChannel) {
    if (!newChannel?.guild?.id || oldChannel?.name === newChannel?.name) return;
    if (!/ticket-\d+/i.test(String(newChannel.name || ''))) return;

    try {
      const ticketData = await getTicketData(newChannel.guild.id, newChannel.id);
      if (!ticketData) return;

      const pinned = String(newChannel.name || '').includes(PIN_EMOJI);
      if (Boolean(ticketData.pinned) === pinned) return;

      ticketData.pinned = pinned;
      ticketData.pinnedUpdatedAt = new Date().toISOString();
      await saveTicketData(newChannel.guild.id, newChannel.id, ticketData);
    } catch (error) {
      logger.warn('Could not persist ticket pin state from channel update', {
        guildId: newChannel?.guild?.id,
        channelId: newChannel?.id,
        error: error.message,
      });
    }
  },
};
