import { Events } from 'discord.js';
import { getTicketData, saveTicketData } from '../utils/database.js';
import { logger } from '../utils/logger.js';

function isMainTicketMessage(message, clientUserId) {
  return Boolean(
    message?.guild?.id
    && message.author?.id === clientUserId
    && message.embeds?.some(embed => embed.title?.startsWith('Ticket #'))
  );
}

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(message, client) {
    if (!isMainTicketMessage(message, client.user?.id)) return;

    try {
      const ticketData = await getTicketData(message.guild.id, message.channel.id);
      if (!ticketData) return;

      const pinned = String(message.channel.name || '').includes('📌');
      const needsSave =
        ticketData.ticketMessageId !== message.id
        || Boolean(ticketData.pinned) !== pinned;

      if (!needsSave) return;

      ticketData.ticketMessageId = message.id;
      ticketData.pinned = pinned;
      ticketData.lastStateSyncAt = new Date().toISOString();
      await saveTicketData(message.guild.id, message.channel.id, ticketData);
    } catch (error) {
      logger.warn('Could not persist main ticket message state', {
        guildId: message.guild?.id,
        channelId: message.channel?.id,
        messageId: message.id,
        error: error.message,
      });
    }
  },
};
