import { Events } from 'discord.js';
import { brandTicketStatusMessage } from '../services/ticketStatusBrandingService.js';

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(message, client) {
    await brandTicketStatusMessage(message, client).catch(() => {});
  },
};
