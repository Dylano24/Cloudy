import { Events } from 'discord.js';
import { enforceTicketControlLayout } from '../services/ticketControlLayoutService.js';

export default {
  name: Events.MessageCreate,
  async execute(message) {
    await enforceTicketControlLayout(message);
  },
};
