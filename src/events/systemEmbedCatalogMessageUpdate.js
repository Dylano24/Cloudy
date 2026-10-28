import { Events } from 'discord.js';
import { syncSystemEmbedCatalogMessage } from '../services/systemEmbedCatalogService.js';
import { logger } from '../utils/logger.js';
import { resolveUpdatedMessage } from '../utils/updatedMessage.js';

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(oldMessage, newMessage) {
    const message = await resolveUpdatedMessage(newMessage);
    if (!message) return;

    await syncSystemEmbedCatalogMessage(message).catch(error => {
      logger.warn(`System embed catalog sync failed: ${error.message}`);
    });
  },
};
