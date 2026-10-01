import { Events } from 'discord.js';
import { reconcileFaqAiPanel } from '../services/faqAiService.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    // The reconciler resolves the restored Sep 18 FAQ channel by alias and
    // preserves any existing Builder-managed panel before creating a fallback.
    await reconcileFaqAiPanel(client);
  },
};
