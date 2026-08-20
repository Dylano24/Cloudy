import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';

const BOT_NAME = 'Cloudy Manager';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    if (!client.user || client.user.username === BOT_NAME) return;

    try {
      await client.user.setUsername(BOT_NAME);
      logger.info(`Bot username restored to ${BOT_NAME}`);
    } catch (error) {
      logger.warn(`Could not restore bot username to ${BOT_NAME}: ${error?.message || error}`);
    }
  },
};
