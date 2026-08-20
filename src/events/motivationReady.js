import { Events } from 'discord.js';
import { startMotivationScheduler } from '../services/motivationService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    try {
      startMotivationScheduler(client);
    } catch (error) {
      logger.warn(`Motivation scheduler could not start: ${error?.message || error}`);
    }
  },
};
