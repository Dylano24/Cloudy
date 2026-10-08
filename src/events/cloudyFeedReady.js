import { Events } from 'discord.js';
import { startCloudyFeedSchedule } from '../services/cloudyFeedService.js';

export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    startCloudyFeedSchedule(client);
  },
};
