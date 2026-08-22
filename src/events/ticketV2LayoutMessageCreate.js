import { Events } from 'discord.js';
import { renderTicketV2 } from '../services/ticketV2LayoutService.js';

export default {
  name: Events.MessageCreate,
  async execute(message) {
    if (!message?.guild || !message?.channel || !message?.author?.bot) return;
    if (!message.embeds?.[0]?.title?.startsWith('Ticket #')) return;

    const timer = setTimeout(() => {
      renderTicketV2(message.channel, message).catch(() => {});
    }, 250);
    timer.unref?.();
  },
};
