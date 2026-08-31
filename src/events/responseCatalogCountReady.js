import { Events } from 'discord.js';
import { getEmbedRegistry } from '../services/embedRegistryService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    const timer = setTimeout(async () => {
      for (const guild of client.guilds.cache.values()) {
        const records = await getEmbedRegistry(guild.id).catch(() => []);
        const system = records.filter(record => record.source === 'system-catalog').length;
        logger.warn(`[EMBED_BUILDER_COUNT] total=${records.length} system=${system}`);
      }
    }, 7000);
    timer.unref?.();
  },
};
