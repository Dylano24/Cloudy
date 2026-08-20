import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { isPlayerCommand } from '../../config/playerCommands.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getSubcommandInfo(commandData) {
  const subcommands = [];
  for (const option of commandData?.options || []) {
    if (option.type === 1) {
      subcommands.push(option.name);
    } else if (option.type === 2) {
      for (const subOption of option.options || []) {
        if (subOption.type === 1) subcommands.push(`${option.name}/${subOption.name}`);
      }
    }
  }
  return subcommands;
}

async function getAllFiles(directory, fileList = []) {
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // Keep the stable production command set under Discord's 100 top-level limit.
      if (entry.name === 'modules' || entry.name === 'Leveling') continue;
      await getAllFiles(filePath, fileList);
    } else if (entry.name.endsWith('.js')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

export async function loadCommands(client) {
  client.commands = new Collection();
  const commandsPath = path.join(__dirname, '../../commands');
  const commandFiles = await getAllFiles(commandsPath);
  const seen = new Set();

  logger.info(`[COMMAND_LOAD] Found ${commandFiles.length} command files.`);

  for (const filePath of commandFiles) {
    try {
      const module = await import(pathToFileURL(filePath).href);
      const command = module.default || module;
      if (!command?.data || typeof command.data.toJSON !== 'function' || typeof command.execute !== 'function') {
        continue;
      }

      const commandName = command.data.toJSON()?.name;
      if (!commandName || seen.has(commandName)) {
        if (commandName) logger.warn(`[COMMAND_LOAD] Duplicate /${commandName} ignored: ${filePath}`);
        continue;
      }
      seen.add(commandName);

      command.category = command.category || path.basename(path.dirname(filePath));
      command.filePath = filePath.replace(/\\/g, '/');
      if (typeof command.adminOnly !== 'boolean') {
        command.adminOnly = !isPlayerCommand(commandName);
      }
      client.commands.set(commandName, command);

      const subcommands = getSubcommandInfo(command.data.toJSON());
      logger.info(`[COMMAND_LOAD] /${commandName}${subcommands.length ? ` -> ${subcommands.join(', ')}` : ''}`);
    } catch (error) {
      logger.error(`[COMMAND_LOAD] Failed ${filePath}:`, error);
    }
  }

  logger.info(`[COMMAND_LOAD] Loaded ${client.commands.size} unique top-level commands.`);
  return client.commands;
}

// Slash registration is intentionally handled by scripts/register-cloudy-guild-commands.js
// before the bot starts. Do NOT perform a second registration here: Discord has a daily
// application-command create limit, and repeated destructive syncs can exhaust it and
// block the actual bot process from ever reaching READY.
export async function registerCommands(client) {
  logger.info(
    `[COMMAND_SYNC] Runtime registration skipped. Pre-start sync is the single source of truth; ` +
    `${client?.commands?.size ?? 0} commands are loaded for interaction handling.`
  );
  return {
    skipped: true,
    reason: 'prestart-single-source-of-truth',
    loadedCommands: client?.commands?.size ?? 0,
  };
}

export async function reloadCommand(client, commandName) {
  const existing = client.commands.get(commandName);
  if (!existing) {
    return { success: false, message: `Command "${commandName}" not found` };
  }

  try {
    const commandPath = path.resolve(existing.filePath);
    const moduleUrl = pathToFileURL(commandPath);
    moduleUrl.searchParams.set('t', Date.now().toString());
    const module = await import(moduleUrl.href);
    const fresh = module.default || module;

    fresh.category = fresh.category || existing.category;
    fresh.filePath = existing.filePath;
    if (typeof fresh.adminOnly !== 'boolean') fresh.adminOnly = existing.adminOnly;

    client.commands.set(commandName, fresh);
    logger.info(`[COMMAND_RELOAD] Reloaded /${commandName}.`);
    return { success: true, message: `Successfully reloaded command "${commandName}"` };
  } catch (error) {
    logger.error(`[COMMAND_RELOAD] Failed /${commandName}:`, error);
    return { success: false, message: `Error reloading command: ${error.message}` };
  }
}
