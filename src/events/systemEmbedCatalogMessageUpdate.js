import { Events } from 'discord.js';
import { syncSystemEmbedCatalogMessage } from '../services/systemEmbedCatalogService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(oldMessage, newMessage) {
    const message = newMessage?.partial
      ? await newMessage.fetch().catch(() => null)
      : newMessage;
    if (!message) return;

    await syncSystemEmbedCatalogMessage(message).catch(error => {
      logger.warn(`System embed catalog sync failed: ${error.message}`);
    });
  },
};
