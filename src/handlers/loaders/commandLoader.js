import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { isPlayerCommand } from '../../config/playerCommands.js';
import { isGamblingGameCommand } from '../../config/gamblingCommands.js';
import { enforceDedicatedCommandChannel } from '../../services/dedicatedChannelService.js';
import { Mutex } from '../../utils/mutex.js';

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

function collectInteractionUserIds(interaction) {
  const userIds = new Set();
  if (interaction?.user?.id) userIds.add(String(interaction.user.id));

  const visitOptions = (options = []) => {
    for (const option of options) {
      if (option?.user?.id) userIds.add(String(option.user.id));
      if (option?.member?.id) userIds.add(String(option.member.id));
      if (option?.type === 6 && option?.value) userIds.add(String(option.value));
      if (Array.isArray(option?.options)) visitOptions(option.options);
    }
  };

  visitOptions(interaction?.options?.data || []);
  return [...userIds];
}

function wrapEconomyCommandExecution(command) {
  if (String(command?.category || '').toLowerCase() !== 'economy' || command.__economySerialized) {
    return command;
  }

  const originalExecute = command.execute;
  command.execute = async function serializedEconomyExecute(...args) {
    const interaction = args[0];
    const guildId = String(interaction?.guildId || interaction?.guild?.id || 'global');
    const lockKeys = collectInteractionUserIds(interaction)
      .map(userId => `economy:${guildId}:${userId}`);

    if (lockKeys.length === 0) {
      return originalExecute.apply(this, args);
    }

    return Mutex.runExclusiveMany(lockKeys, () => originalExecute.apply(this, args));
  };

  Object.defineProperty(command, '__economySerialized', {
    value: true,
    configurable: true,
  });

  return command;
}

function wrapDedicatedGamblingCommandExecution(command, commandName) {
  if (!isGamblingGameCommand(commandName) || command.__gamblingChannelGuarded) {
    return command;
  }

  const originalExecute = command.execute;
  command.execute = async function dedicatedGamblingExecute(...args) {
    const interaction = args[0];
    await enforceDedicatedCommandChannel(interaction, 'gambling');
    return originalExecute.apply(this, args);
  };

  Object.defineProperty(command, '__gamblingChannelGuarded', {
    value: true,
    configurable: true,
  });

  return command;
}

async function getAllFiles(directory, fileList = []) {
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // Module files are implementation details, not top-level slash commands.
      // Load every real command directory, including Leveling. The current
      // production set is exactly Discord's 100 top-level command limit.
      if (entry.name === 'modules') continue;
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
  const loadErrors = [];

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
      wrapEconomyCommandExecution(command);
      wrapDedicatedGamblingCommandExecution(command, commandName);
      client.commands.set(commandName, command);

      const subcommands = getSubcommandInfo(command.data.toJSON());
      logger.info(`[COMMAND_LOAD] /${commandName}${subcommands.length ? ` -> ${subcommands.join(', ')}` : ''}`);
    } catch (error) {
      loadErrors.push({ filePath, message: error.message });
      logger.error(`[COMMAND_LOAD] Failed ${filePath}:`, error);
    }
  }

  if (loadErrors.length > 0) {
    throw new Error(
      `[COMMAND_LOAD] Aborting startup because ${loadErrors.length} command file(s) failed to load.`,
    );
  }

  logger.info(`[COMMAND_LOAD] Loaded ${client.commands.size} unique top-level commands.`);
  return client.commands;
}

// Slash registration is intentionally handled by scripts/register-cloudy-guild-commands.js
// alongside the bot process. Do NOT perform a second registration here: repeated syncs
// consume Discord's application-command create quota and can delay command visibility.
export async function registerCommands(client) {
  logger.info(
    `[COMMAND_SYNC] Runtime registration skipped. Recovery sync is the single source of truth; ` +
    `${client?.commands?.size ?? 0} commands are loaded for interaction handling.`
  );
  return {
    skipped: true,
    reason: 'recovery-single-source-of-truth',
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
    wrapEconomyCommandExecution(fresh);
    wrapDedicatedGamblingCommandExecution(fresh, commandName);

    client.commands.set(commandName, fresh);
    logger.info(`[COMMAND_RELOAD] Reloaded /${commandName}.`);
    return { success: true, message: `Successfully reloaded command "${commandName}"` };
  } catch (error) {
    logger.error(`[COMMAND_RELOAD] Failed /${commandName}:`, error);
    return { success: false, message: `Error reloading command: ${error.message}` };
  }
}
