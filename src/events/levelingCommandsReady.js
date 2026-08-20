import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { loadLevelingCommandsAtRuntime } from '../services/levelingCommandRuntimeService.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      const loaded = await loadLevelingCommandsAtRuntime(client);
      logger.info(`[LEVELING_RUNTIME] Ready sync loaded ${loaded} command(s).`);
    } catch (error) {
      logger.error('[LEVELING_RUNTIME] Ready sync failed:', error);
    }
  },
};
