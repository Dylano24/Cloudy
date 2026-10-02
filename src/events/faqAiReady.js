import { Events } from 'discord.js';
import { reconcileFaqAiPanel } from '../services/faqAiService.js';
import { cleanupGeneratedKnowledgePanels } from '../services/cloudyPublicKnowledgeService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const cleanupResults = await cleanupGeneratedKnowledgePanels(client).catch(error => {
      logger.error('[CLOUDY_KNOWLEDGE] Cleanup failed:', error);
      return [];
    });
    const removed = cleanupResults.filter(result => result.removed).length;
    logger.info(`[CLOUDY_KNOWLEDGE] Standalone panels disabled; removed ${removed} tracked panel(s)`);

    // The reconciler resolves the restored Sep 18 FAQ channel by alias and
    // preserves any existing Builder-managed panel before creating a fallback.
    await reconcileFaqAiPanel(client);
  },
};
