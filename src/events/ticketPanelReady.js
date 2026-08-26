import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute() {
    // Ticket panels are intentionally never created automatically on startup.
    // Saved panel title/message/button changes are applied only when an admin
    // explicitly presses Repost Panel in the ticket dashboard.
    logger.info('Automatic ticket panel startup posting is disabled; Repost Panel is authoritative.');
  },
};
