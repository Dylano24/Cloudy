import { Events } from 'discord.js';
import { scheduleDedicatedChannelGuide } from '../services/dedicatedChannelService.js';

export default {
  name: Events.MessageCreate,
  execute(message) {
    scheduleDedicatedChannelGuide(message);
  },
};
