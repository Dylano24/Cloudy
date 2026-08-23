import { Events } from 'discord.js';
import { ensureDedicatedChannelGuides } from '../services/dedicatedChannelService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      const results = await ensureDedicatedChannelGuides(client).catch(error => {
        logger.warn(`Dedicated channel guide setup failed: ${error.message}`);
        return [];
      });

      const successful = results.filter(result => result.ok).length;
      logger.info(`Dedicated channel guides ready: ${successful}/${results.length}`);
    }, 3000);

    timer.unref?.();
  },
};
