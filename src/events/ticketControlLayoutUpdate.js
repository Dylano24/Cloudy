import { Events } from 'discord.js';
import { enforceTicketControlLayout } from '../services/ticketControlLayoutService.js';
import { resolveUpdatedMessage } from '../utils/updatedMessage.js';

export default {
  name: Events.MessageUpdate,
  async execute(_oldMessage, newMessage) {
    const message = await resolveUpdatedMessage(newMessage, { cloudyOnly: true });
    if (!message) return;
    await enforceTicketControlLayout(message);
  },
};
