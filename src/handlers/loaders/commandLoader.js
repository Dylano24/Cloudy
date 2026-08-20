import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection, PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { isPlayerCommand } from '../../config/playerCommands.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_COMMANDS_PER_SCOPE = 100;
const MAX_OPTIONS_PER_COMMAND = 25;

// These are the legacy Cloudy admin commands the server relied on directly.
// Never hide/group them: they must keep showing as /ban, /unban, /timeout, etc.
const LEGACY_LOOSE_CATEGORIES = new Set(['moderation', 'ticket']);
const LEGACY_LOOSE_NAMES = new Set([
  'ban', 'unban', 'kick', 'timeout', 'untimeout', 'warn', 'warnings',
  'massban', 'masskick', 'purge', 'lock', 'unlock', 'cases', 'usernotes',
  'dm', 'say', 'ticket', 'claim', 'close', 'priority',
]);

function normalizeCategory(category) {
  return String(category || 'admin')
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'admin';
}

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

function hasNestedCommands(payload) {
  return (payload?.options || []).some(option => option.type === 1 || option.type === 2);
}

async function getAllFiles(directory, fileList = []) {
  const files = await fs.readdir(directory, { withFileTypes: true });
  for (const file of files) {
    const filePath = path.join(directory, file.name);
    if (file.isDirectory()) {
      if (file.name === 'modules') continue;
      await getAllFiles(filePath, fileList);
    } else if (file.name.endsWith('.js')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

function makeVirtualGroupName(category, index) {
  const base = `admin-${normalizeCategory(category)}`.slice(0, 28);
  return index === 1 ? base : `${base}-${index}`.slice(0, 32);
}

function buildVirtualAdminGroups(client) {
  const candidatesByCategory = new Map();

  for (const [name, command] of client.commands.entries()) {
    if (!command.adminOnly || command.virtualGroup) continue;

    const categoryLower = String(command.category || '').toLowerCase();
    if (LEGACY_LOOSE_CATEGORIES.has(categoryLower) || LEGACY_LOOSE_NAMES.has(name)) continue;

    const payload = command.data?.toJSON?.();
    if (!payload || hasNestedCommands(payload)) continue;

    // A top-level command can safely become one subcommand while retaining its
    // normal primitive options (user/string/integer/channel/etc.).
    if (!candidatesByCategory.has(command.category)) candidatesByCategory.set(command.category, []);
    candidatesByCategory.get(command.category).push({ name, command, payload });
  }

  for (const [category, candidates] of candidatesByCategory.entries()) {
    candidates.sort((a, b) => a.name.localeCompare(b.name));

    for (let offset = 0, groupIndex = 1; offset < candidates.length; offset += MAX_OPTIONS_PER_COMMAND, groupIndex++) {
      const chunk = candidates.slice(offset, offset + MAX_OPTIONS_PER_COMMAND);
      const groupName = makeVirtualGroupName(category, groupIndex);
      const routeMap = new Map();

      const options = chunk.map(({ name, command, payload }) => {
        command.registrationHidden = true;
        routeMap.set(name, command);
        return {
          type: 1,
          name,
          description: String(payload.description || `Run ${name}`).slice(0, 100),
          options: payload.options || [],
        };
      });

      const virtualCommand = {
        virtualGroup: true,
        adminOnly: true,
        category,
        data: {
          name: groupName,
          toJSON() {
            return {
              name: groupName,
              description: `Cloudy ${normalizeCategory(category)} administration commands`.slice(0, 100),
              type: 1,
              default_member_permissions: PermissionFlagsBits.Administrator.toString(),
              options,
            };
          },
        },
        async execute(interaction, guildConfig, runtimeClient) {
          const selected = interaction.options.getSubcommand();
          const target = routeMap.get(selected);
          if (!target) throw new Error(`No Cloudy command route for ${groupName} ${selected}`);
          return target.execute(interaction, guildConfig, runtimeClient);
        },
      };

      if (client.commands.has(groupName)) {
        throw new Error(`Generated admin group /${groupName} conflicts with an existing command`);
      }
      client.commands.set(groupName, virtualCommand);
      logger.info(`[COMMAND_GROUP] /${groupName}: ${chunk.map(item => item.name).join(', ')}`);
    }
  }
}

export async function loadCommands(client) {
  client.commands = new Collection();
  const commandsPath = path.join(__dirname, '../../commands');
  const commandFiles = await getAllFiles(commandsPath);
  const uniqueCommandNames = new Set();

  logger.info(`Found ${commandFiles.length} command files to load`);

  for (const filePath of commandFiles) {
    try {
      const normalizedPath = filePath.replace(/\\/g, '/');
      const category = path.basename(path.dirname(filePath));
      const commandModule = await import(`file://${filePath}`);
      const command = commandModule.default || commandModule;

      if (!command.data || !command.execute) {
        logger.warn(`Command at ${filePath} is missing required data or execute property`);
        continue;
      }

      const commandName = command.data.name;
      if (!commandName) continue;
      if (uniqueCommandNames.has(commandName)) {
        logger.warn(`Skipping duplicate top-level command /${commandName} from ${normalizedPath}`);
        continue;
      }

      uniqueCommandNames.add(commandName);
      command.category = category;
      command.filePath = normalizedPath;
      command.adminOnly = !isPlayerCommand(commandName);
      command.registrationHidden = false;
      client.commands.set(commandName, command);

      const subcommands = getSubcommandInfo(command.data.toJSON());
      logger.info(`Loaded /${commandName} (${category})${subcommands.length ? ` -> ${subcommands.join(', ')}` : ''}`);
    } catch (error) {
      logger.error(`Error loading command from ${filePath}:`, error);
    }
  }

  // Reduce top-level admin command usage without touching the legacy moderation
  // and ticket names. Grouped originals remain in client.commands for dispatch.
  buildVirtualAdminGroups(client);

  logger.info(`Loaded ${client.commands.size} runtime commands (including virtual admin groups)`);
  return client.commands;
}

function validateCommands(commands, scopeName) {
  const errors = [];
  if (commands.length > MAX_COMMANDS_PER_SCOPE) {
    errors.push(`${scopeName} contains ${commands.length} top-level commands; Discord allows ${MAX_COMMANDS_PER_SCOPE}`);
  }

  for (const cmd of commands) {
    if (cmd.name?.length > 32) errors.push(`/${cmd.name} name exceeds 32 characters`);
    if (cmd.description?.length > 100) errors.push(`/${cmd.name} description exceeds 100 characters`);
    if ((cmd.options || []).length > 25) errors.push(`/${cmd.name} has more than 25 options/subcommands`);

    for (const option of cmd.options || []) {
      if (option.name?.length > 32) errors.push(`/${cmd.name} option ${option.name} exceeds 32 characters`);
      if (option.description?.length > 100) errors.push(`/${cmd.name} option ${option.name} description exceeds 100 characters`);
      if ((option.options || []).length > 25) errors.push(`/${cmd.name} option ${option.name} has more than 25 nested options`);
    }
  }

  if (errors.length) {
    errors.forEach(error => logger.error(`[COMMAND_VALIDATION] ${error}`));
    throw new Error(`Command validation failed for ${scopeName} with ${errors.length} error(s)`);
  }
}

function collectCommandPayloads(client) {
  const memberCommands = [];
  const adminCommands = [];

  for (const command of client.commands.values()) {
    if (command.registrationHidden) continue;
    if (!command.data || typeof command.data.toJSON !== 'function') continue;

    const payload = command.data.toJSON();
    if (command.adminOnly) {
      payload.default_member_permissions = PermissionFlagsBits.Administrator.toString();
      adminCommands.push(payload);
    } else {
      memberCommands.push(payload);
    }
  }

  return { memberCommands, adminCommands };
}

function getAuthenticatedApplicationId(client, configuredClientId = null) {
  const authenticatedId = client.user?.id;
  if (!authenticatedId) throw new Error('Cannot register slash commands before Discord login is ready');

  if (configuredClientId && String(configuredClientId) !== String(authenticatedId)) {
    logger.warn(`[COMMAND_REGISTRATION] Ignoring mismatched CLIENT_ID ${configuredClientId}; authenticated app=${authenticatedId}`);
  }
  return authenticatedId;
}

async function putGlobalCommands(client, applicationId, memberCommands) {
  validateCommands(memberCommands, 'global member scope');
  const result = await client.rest.put(`/applications/${applicationId}/commands`, { body: memberCommands });
  logger.info(`Registered ${result.length} global member commands for application ${applicationId}`);
  return result;
}

export async function registerGuildCommandsForGuild(client, guildId, options = {}) {
  const applicationId = getAuthenticatedApplicationId(client, options.clientId || null);
  const { adminCommands } = collectCommandPayloads(client);
  validateCommands(adminCommands, `guild ${guildId} admin scope`);

  const result = await client.rest.put(
    `/applications/${applicationId}/guilds/${guildId}/commands`,
    { body: adminCommands },
  );

  const returnedNames = new Set(result.map(command => command.name));
  for (const required of ['ban', 'unban', 'kick', 'timeout', 'untimeout', 'ticket']) {
    if (!returnedNames.has(required)) {
      throw new Error(`Discord did not return required Cloudy command /${required} for guild ${guildId}`);
    }
  }

  logger.info(`Registered ${result.length} Cloudy admin commands in guild ${guildId}; legacy moderation verified`);
  return result;
}

export async function registerCommands(client, options = {}) {
  const applicationId = getAuthenticatedApplicationId(client, options.clientId || null);
  const { memberCommands, adminCommands } = collectCommandPayloads(client);

  logger.info(`[COMMAND_REGISTRATION] application=${applicationId} member=${memberCommands.length} admin=${adminCommands.length} guilds=${client.guilds.cache.size}`);
  validateCommands(memberCommands, 'global member scope');
  validateCommands(adminCommands, 'guild admin scope');

  await putGlobalCommands(client, applicationId, memberCommands);
  for (const guild of client.guilds.cache.values()) {
    await registerGuildCommandsForGuild(client, guild.id, { clientId: applicationId });
  }

  logger.info('[COMMAND_REGISTRATION] Slash command sync completed successfully');
}

export async function reloadCommand(client, commandName) {
  const command = client.commands.get(commandName);
  if (!command) return { success: false, message: `Command "${commandName}" not found` };
  if (command.virtualGroup) return { success: false, message: 'Virtual command groups reload on restart' };

  try {
    const commandPath = path.resolve(command.filePath);
    const moduleUrl = pathToFileURL(commandPath);
    moduleUrl.searchParams.set('t', Date.now().toString());
    const newCommand = (await import(moduleUrl.href)).default;
    newCommand.category = command.category;
    newCommand.filePath = command.filePath;
    newCommand.adminOnly = !isPlayerCommand(newCommand.data?.name);
    newCommand.registrationHidden = command.registrationHidden;
    client.commands.set(commandName, newCommand);
    return { success: true, message: `Successfully reloaded command "${commandName}"` };
  } catch (error) {
    logger.error(`Error reloading command "${commandName}":`, error);
    return { success: false, message: `Error reloading command: ${error.message}` };
  }
}
