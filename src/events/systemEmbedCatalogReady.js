import { Events } from 'discord.js';
import { ensureSystemEmbedCatalogs } from '../services/systemEmbedCatalogService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,

  execute(client) {
    const timer = setTimeout(async () => {
      // The old catalog-scope repair was intentionally a migration, not a
      // permanent startup job. Running it on every boot re-copied historical
      // title aliases into live channel scopes and made the Builder registry
      // appear to grow even though no new logical embed type existed.
      //
      // The scope bug is already repaired and existing installations have been
      // migrated. From now on the stable system-template key is the source of
      // truth, so startup only ensures the catalog itself is present.
      logger.warn('[EMBED_BUILDER] Legacy catalog scope migration retired; stable template identities are authoritative.');

      await ensureSystemEmbedCatalogs(client).catch(error => {
        logger.warn(`System embed catalog setup failed: ${error.message}`);
      });
    }, 3500);

    timer.unref?.();
  },
};
