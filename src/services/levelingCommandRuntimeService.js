import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { logger } from '../utils/logger.js';
import { botConfig } from '../config/bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MEMBER_LEVELING_COMMANDS = new Set(['rank', 'leaderboard']);

export async function loadLevelingCommandsAtRuntime(client) {
  const commandsDir = path.join(__dirname, '../commands/Leveling');
  const entries = await fs.readdir(commandsDir, { withFileTypes: true });
  let loaded = 0;

  // The restored legacy loader skips this whole category. Enable the feature at
  // runtime without rewriting the original 06:00 loader/config files.
  botConfig.features.leveling = true;
  if (client.config?.features) {
    client.config.features.leveling = true;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      continue;
    }

    const filePath = path.join(commandsDir, entry.name);
    try {
      const moduleUrl = pathToFileURL(filePath);
      moduleUrl.searchParams.set('runtime', Date.now().toString());
      const imported = await import(moduleUrl.href);
      const command = imported.default || imported;

      if (!command?.data || typeof command.execute !== 'function' || !command.data.name) {
        logger.warn(`[LEVELING_RUNTIME] Skipping invalid command file ${entry.name}`);
        continue;
      }

      const name = command.data.name;
      command.category = 'Leveling';
      command.filePath = filePath.replace(/\\/g, '/');
      command.adminOnly = !MEMBER_LEVELING_COMMANDS.has(name);

      if (client.commands.has(name)) {
        logger.info(`[LEVELING_RUNTIME] /${name} already loaded; keeping existing command.`);
        continue;
      }

      client.commands.set(name, command);
      loaded += 1;
      logger.info(`[LEVELING_RUNTIME] Loaded /${name}`);
    } catch (error) {
      logger.error(`[LEVELING_RUNTIME] Failed to load ${entry.name}:`, error);
    }
  }

  logger.info(`[LEVELING_RUNTIME] Loaded ${loaded} additional leveling command(s).`);
  return loaded;
}
