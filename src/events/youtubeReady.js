import { Events } from 'discord.js';
import { startYouTubeSubscriptionMonitor } from '../services/youtubeService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    try {
      startYouTubeSubscriptionMonitor(client);
    } catch (error) {
      logger.warn(`YouTube upload monitor could not start: ${error?.message || error}`);
    }
  },
};
