import { Events } from 'discord.js';
import { brandTicketStatusMessage } from '../services/ticketStatusBrandingService.js';

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(_oldMessage, newMessage, client) {
    await brandTicketStatusMessage(newMessage, client).catch(() => {});
  },
};
