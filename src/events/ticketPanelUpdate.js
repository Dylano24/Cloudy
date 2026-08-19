import { Events } from 'discord.js';
import {
  applyTicketPanelPresentation,
  isTicketPanelMessage,
} from '../services/ticketPanelPresentation.js';

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(_oldMessage, newMessage) {
    let message = newMessage;

    if (message?.partial) {
      message = await message.fetch().catch(() => null);
    }

    if (!message?.guild || message.author?.id !== message.client.user?.id) return;
    if (!isTicketPanelMessage(message)) return;

    await applyTicketPanelPresentation(message);
  },
};
