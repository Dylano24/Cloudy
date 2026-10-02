import { Events } from 'discord.js';
import { cleanupGeneratedKnowledgePanels } from '../services/cloudyPublicKnowledgeService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      const results = await cleanupGeneratedKnowledgePanels(client).catch(error => {
        logger.error('[CLOUDY_KNOWLEDGE] Cleanup failed:', error);
        return [];
      });

      const removed = results.filter(result => result.removed).length;
      logger.info(`[CLOUDY_KNOWLEDGE] Standalone knowledge panels disabled; removed ${removed} tracked panel(s)`);
    }, 4000);

    timer.unref?.();
  },
};
