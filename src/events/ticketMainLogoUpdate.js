import { Events } from 'discord.js';
import { ensureExactWelcomeLogoOnTicket } from '../services/ticketMainLogoPresentation.js';

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(_oldMessage, newMessage) {
    if (!newMessage?.guild || newMessage.author?.id !== newMessage.client.user?.id) return;
    if (!newMessage.embeds?.[0]?.title?.startsWith('Ticket #')) return;

    await ensureExactWelcomeLogoOnTicket(newMessage);
  },
};
