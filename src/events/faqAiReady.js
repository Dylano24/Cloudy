import { Events } from 'discord.js';
import { reconcileFaqAiPanel } from '../services/faqAiService.js';
import { cleanupGeneratedKnowledgePanels, getCloudyKnowledgeChannels } from '../services/cloudyPublicKnowledgeService.js';
import { logger, startupLog } from '../utils/logger.js';

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
    const panel = await reconcileFaqAiPanel(client);
    if (panel?.guild) {
      const channels = await getCloudyKnowledgeChannels(panel.guild);
      startupLog(`FAQ knowledge linked to ${channels.length} current channels and threads; requester permissions checked per question.`);
    }
  },
};
