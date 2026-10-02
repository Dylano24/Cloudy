import { Events } from 'discord.js';
import { reconcileRestoredKnowledgePanels } from '../services/cloudyPublicKnowledgeService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      const results = await reconcileRestoredKnowledgePanels(client).catch(error => {
        logger.error('[CLOUDY_KNOWLEDGE] Public knowledge restore failed:', error);
        return [];
      });

      const successful = results.filter(result => result.ok).length;
      logger.info(`[CLOUDY_KNOWLEDGE] Verified public panels ready: ${successful}/${results.length}`);
    }, 4000);

    timer.unref?.();
  },
};
