import { Events } from 'discord.js';
import { ensureExactWelcomeLogoOnTicket } from '../services/ticketMainLogoPresentation.js';

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(message) {
    if (!message?.guild || message.author?.id !== message.client.user?.id) return;
    if (!message.embeds?.[0]?.title?.startsWith('Ticket #')) return;

    // Let the normal ticket UI finish its first sync, then apply the exact
    // welcome C. MessageUpdate protection keeps it there after later syncs.
    setTimeout(() => {
      void ensureExactWelcomeLogoOnTicket(message);
    }, 350).unref?.();
  },
};
