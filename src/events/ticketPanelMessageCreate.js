import { Events } from 'discord.js';
import { normalizeTicketPanelMessage } from '../utils/ticket/ticketPanelAppearance.js';

export default {
  name: Events.MessageCreate,
  async execute(message) {
    await normalizeTicketPanelMessage(message);
  },
};
