import { Events } from 'discord.js';
import ticketDashboardSelectHandlers from '../interactions/selectMenus/ticket/ticketDashboard.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    for (const handler of ticketDashboardSelectHandlers) {
      if (!handler?.name || typeof handler.execute !== 'function') continue;
      client.selectMenus.set(handler.name, handler);
    }

    logger.info('Ticket dashboard select handlers verified at startup', {
      handlers: ticketDashboardSelectHandlers.map(handler => handler?.name).filter(Boolean),
    });
  },
};
