import { Events } from 'discord.js';
import { ensureSystemEmbedCatalogs } from '../services/systemEmbedCatalogService.js';
import { reconcileEmbedRegistry } from '../services/embedRegistryService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      const ready = await ensureSystemEmbedCatalogs(client)
        .then(() => true)
        .catch(error => {
          logger.warn(`System embed catalog setup failed: ${error.message}`);
          return false;
        });

      if (!ready) return;

      for (const guild of client.guilds.cache.values()) {
        await reconcileEmbedRegistry(guild).catch(error => {
          logger.warn(`[EMBED_BUILDER] Registry sync after catalog cleanup failed for ${guild.id}: ${error.message}`);
        });
      }
    }, 3500);

    timer.unref?.();
  },
};
