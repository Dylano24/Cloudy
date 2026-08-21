import { Events } from 'discord.js';
import { reconcileFaqAiPanel } from '../services/faqAiService.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    await reconcileFaqAiPanel(client);
  },
};
