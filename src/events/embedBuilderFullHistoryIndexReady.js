import { Events } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { scanGuildForCloudyEmbeds } from '../services/embedRegistryService.js';

const INDEX_VERSION = 1;
const START_DELAY_MS = 12_000;

export default {
  name: Events.ClientReady,
  once: true,

  execute(client) {
    const timer = setTimeout(async () => {
      for (const guild of client.guilds.cache.values()) {
        const key = `cloudy:embed-builder:full-history-index:${guild.id}`;
        try {
          const completed = Number(await getFromDb(key, 0) || 0);
          if (completed >= INDEX_VERSION) continue;

          const result = await scanGuildForCloudyEmbeds(
            guild,
            client.user.id,
            { maxMessagesPerChannel: Infinity },
          );

          await setInDb(key, INDEX_VERSION);
          logger.info(
            `[EMBED_BUILDER] Full bot history indexed for ${guild.id}: scanned ${result.scanned}, indexed ${result.found} embed(s).`,
          );
        } catch (error) {
          logger.error(`[EMBED_BUILDER] Full history indexing failed for ${guild.id}:`, error);
        }
      }
    }, START_DELAY_MS);

    timer.unref?.();
  },
};
