import { Events } from 'discord.js';
import { startPatchFeedMonitor } from '../services/patchFeedService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    try {
      startPatchFeedMonitor(client);
    } catch (error) {
      logger.warn(`Patch/update monitor could not start: ${error?.message || error}`);
    }
  },
};
