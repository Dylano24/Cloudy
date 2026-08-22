import { Events } from 'discord.js';
import { enforceTicketControlLayout } from '../services/ticketControlLayoutService.js';

export default {
  name: Events.MessageUpdate,
  async execute(_oldMessage, newMessage) {
    const message = newMessage?.partial
      ? await newMessage.fetch().catch(() => null)
      : newMessage;
    if (!message) return;
    await enforceTicketControlLayout(message);
  },
};
