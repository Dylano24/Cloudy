import { Events } from 'discord.js';
import { reconcileZorpGuide } from '../services/zorpGuideService.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    await reconcileZorpGuide(client);
  },
};
