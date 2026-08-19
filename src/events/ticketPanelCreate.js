import { Events } from 'discord.js';
import {
  applyTicketPanelPresentation,
  isTicketPanelMessage,
} from '../services/ticketPanelPresentation.js';

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(message) {
    if (!message?.guild || message.author?.id !== message.client.user?.id) return;
    if (!isTicketPanelMessage(message)) return;

    await applyTicketPanelPresentation(message);
  },
};
