import { Events } from 'discord.js';
import { handleFeedOpenMessage } from '../services/cloudyFeedService.js';

export default {
  name: Events.MessageCreate,
  async execute(message) {
    await handleFeedOpenMessage(message);
  },
};
