import { Events } from 'discord.js';
import { scheduleDedicatedChannelGuide } from '../services/dedicatedChannelService.js';
import { scheduleTransientMessageDeletion } from '../utils/transientResponse.js';

export default {
  name: Events.MessageCreate,
  execute(message) {
    scheduleDedicatedChannelGuide(message);

    if (message.author?.id === message.client?.user?.id) {
      scheduleTransientMessageDeletion(message);
    }
  },
};
