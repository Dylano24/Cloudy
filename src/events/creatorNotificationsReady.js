import { Events } from 'discord.js';
import { startCreatorNotificationMonitor } from '../services/creatorNotificationService.js';

export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    startCreatorNotificationMonitor(client);
  },
};
