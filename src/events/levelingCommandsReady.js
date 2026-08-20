import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { loadLevelingCommandsAtRuntime } from '../services/levelingCommandRuntimeService.js';
import { registerCommands } from '../handlers/loaders/commandLoader.js';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      const loaded = await loadLevelingCommandsAtRuntime(client);
      logger.info(`[LEVELING_RUNTIME] Ready sync loaded ${loaded} command(s).`);

      if (loaded > 0) {
        await registerCommands(client);
        logger.info('[LEVELING_RUNTIME] Slash commands re-synced after Leveling load.');
      }
    } catch (error) {
      logger.error('[LEVELING_RUNTIME] Ready sync failed:', error);
    }
  },
};
