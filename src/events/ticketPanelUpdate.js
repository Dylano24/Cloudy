import { Events } from 'discord.js';
import {
  applyTicketPanelPresentation,
  isTicketPanelMessage,
} from '../services/ticketPanelPresentation.js';
import { resolveUpdatedMessage } from '../utils/updatedMessage.js';

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(_oldMessage, newMessage) {
    const message = await resolveUpdatedMessage(newMessage, { cloudyOnly: true });

    if (!message?.guild || message.author?.id !== message.client.user?.id) return;
    if (!isTicketPanelMessage(message)) return;

    await applyTicketPanelPresentation(message);
  },
};
