import { Events } from 'discord.js';
import { normalizeTicketPanelMessage } from '../utils/ticket/ticketPanelAppearance.js';

export default {
  name: Events.MessageUpdate,
  async execute(_oldMessage, newMessage) {
    await normalizeTicketPanelMessage(newMessage);
  },
};
