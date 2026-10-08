import { Events } from 'discord.js';
import { startAutoFeedScheduler } from '../services/autoFeedService.js';

export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    startAutoFeedScheduler(client);
  },
};
