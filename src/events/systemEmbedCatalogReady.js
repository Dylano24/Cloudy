import { Events } from 'discord.js';
import { ensureSystemEmbedCatalogs } from '../services/systemEmbedCatalogService.js';
import { reconcileEmbedRegistry } from '../services/embedRegistryService.js';
import { logger } from '../utils/logger.js';

const CATALOG_READY_ATTEMPTS = 3;
const CATALOG_READY_RETRY_MS = 1500;

function wait(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function ensureCatalogReadyWithRetry(client, attempts = CATALOG_READY_ATTEMPTS) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await ensureSystemEmbedCatalogs(client);
      return true;
    } catch (error) {
      lastError = error;
      logger.warn(
        `System embed catalog setup attempt ${attempt}/${attempts} failed: ${error?.message || error}`,
      );
      if (attempt < attempts) await wait(CATALOG_READY_RETRY_MS);
    }
  }

  logger.error(
    `System embed catalog did not become complete after ${attempts} attempt(s): ${lastError?.message || lastError}`,
  );
  return false;
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      const ready = await ensureCatalogReadyWithRetry(client);

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
