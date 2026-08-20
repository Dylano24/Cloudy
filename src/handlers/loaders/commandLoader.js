import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { isPlayerCommand } from '../../config/playerCommands.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_COMMANDS = 100;
const COMMAND_COUNT_WARN_THRESHOLD = 90;

const GROUPED_TOP_LEVEL_COMMANDS = new Set([
    'play',
    'queue',
    'nowplaying',
    'join',
]);

function getSubcommandInfo(commandData) {
    const subcommands = [];
    if (commandData.options) {
        for (const option of commandData.options) {
            if (option.type === 1) {
                subcommands.push(option.name);
            } else if (option.type === 2 && option.options) {
                for (const subOption of option.options) {
                    if (subOption.type === 1) subcommands.push(`${option.name}/${subOption.name}`);
                }
            }
        }
    }
    return subcommands;
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

export async function loadCommands(client) {
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, '../../commands');
    const commandFiles = await getAllFiles(commandsPath);
    logger.info(`Found ${commandFiles.length} command files to load`);

    const uniqueCommandNames = new Set();
    for (const filePath of commandFiles) {
        try {
            const normalizedPath = filePath.replace(/\\/g, '/');
            const category = path.basename(path.dirname(filePath));
            const commandModule = await import(pathToFileURL(filePath).href);
            const command = commandModule.default || commandModule;

            if (!command.data || typeof command.execute !== 'function') {
                logger.warn(`Command at ${filePath} is missing required data or execute property.`);
                continue;
            }

            command.category = category;
            command.filePath = normalizedPath;
            const primaryCommandName = command.data.name;
            command.adminOnly = !isPlayerCommand(primaryCommandName);

            if (GROUPED_TOP_LEVEL_COMMANDS.has(primaryCommandName)) {
                logger.info(`Grouped /${primaryCommandName} under /music; not using an extra top-level slot.`);
                continue;
            }

            if (uniqueCommandNames.has(primaryCommandName)) {
                logger.warn(`Skipping duplicate slash command /${primaryCommandName} from ${normalizedPath}`);
                continue;
            }

            uniqueCommandNames.add(primaryCommandName);
            client.commands.set(primaryCommandName, command);

            const subcommands = getSubcommandInfo(command.data.toJSON());
            logger.info(`Loaded command: /${primaryCommandName} (${command.adminOnly ? 'admin' : 'member'}) from ${normalizedPath}`);
            if (subcommands.length > 0) logger.info(`  - Subcommands: ${subcommands.join(', ')}`);
        } catch (error) {
            logger.error(`Error loading command from ${filePath}:`, error);
            throw error;
        }
    }

    logger.info(`Loaded ${client.commands.size} unique slash commands`);
    return client.commands;
}

function collectCommandPayloads(client) {
    const commands = [];
    let totalSubcommands = 0;
    const registeredNames = new Set();

    for (const command of client.commands.values()) {
        if (!command.data || typeof command.data.toJSON !== 'function') continue;
        const commandName = command.data.name;
        if (registeredNames.has(commandName)) continue;
        registeredNames.add(commandName);

        const commandJson = command.data.toJSON();
        if (command.adminOnly && !commandJson.default_member_permissions) {
            commandJson.default_member_permissions = '8';
        }
        commands.push(commandJson);
        totalSubcommands += getSubcommandInfo(commandJson).length;
    }

    return { commands, totalSubcommands };
}

function validateCommands(commands) {
    const validationErrors = [];
    for (const cmd of commands) {
        if (cmd.name && cmd.name.length > 32) validationErrors.push(`Command ${cmd.name} name is too long`);
        if (cmd.description && cmd.description.length > 100) validationErrors.push(`Command ${cmd.name} description is too long`);
        for (const option of cmd.options || []) {
            if (option.name && option.name.length > 32) validationErrors.push(`Command ${cmd.name} option ${option.name} name is too long`);
            if (option.description && option.description.length > 100) validationErrors.push(`Command ${cmd.name} option ${option.name} description is too long`);
            for (const nested of option.options || []) {
                if (nested.name && nested.name.length > 32) validationErrors.push(`Command ${cmd.name} nested option ${nested.name} name is too long`);
                if (nested.description && nested.description.length > 100) validationErrors.push(`Command ${cmd.name} nested option ${nested.name} description is too long`);
            }
        }
    }
    if (validationErrors.length) {
        validationErrors.forEach((error) => logger.error(`  - ${error}`));
        throw new Error(`Command validation failed with ${validationErrors.length} errors`);
    }
}

function prepareCommandsForRegistration(commands) {
    if (commands.length >= COMMAND_COUNT_WARN_THRESHOLD) {
        logger.warn(`Command count (${commands.length}) is near Discord's ${MAX_COMMANDS} command limit`);
    }
    if (commands.length > MAX_COMMANDS) {
        throw new Error(`Cloudy has ${commands.length} top-level slash commands; Discord allows ${MAX_COMMANDS}. Refusing to hide commands silently.`);
    }
    return commands;
}

async function registerGuild(client, guild, commandsToRegister) {
    const registered = await guild.commands.set(commandsToRegister);
    const registeredNames = new Set([...registered.values()].map((command) => command.name));
    const missing = commandsToRegister
        .map((command) => command.name)
        .filter((name) => !registeredNames.has(name));

    if (missing.length > 0) {
        throw new Error(`Discord did not register ${missing.length} command(s) in ${guild.name}: ${missing.join(', ')}`);
    }

    logger.info(`Successfully registered all ${commandsToRegister.length} Cloudy commands in ${guild.name} (${guild.id})`);
    return registered.size;
}

export async function registerCommands(client, options = {}) {
    const authenticatedClientId = client.user?.id || options.clientId;
    if (!authenticatedClientId) throw new Error('Could not resolve Discord application ID');
    if (!client.rest) throw new Error('Discord REST client is not available for slash command registration');

    const { commands, totalSubcommands } = collectCommandPayloads(client);
    validateCommands(commands);
    const commandsToRegister = prepareCommandsForRegistration(commands);

    logger.info(`Preparing ${commandsToRegister.length} top-level commands + ${totalSubcommands} subcommands for ${client.guilds.cache.size} connected guild(s)`);

    // Remove stale global copies first so Discord cannot show duplicate Cloudy commands.
    await client.rest.put(`/applications/${authenticatedClientId}/commands`, { body: [] });

    if (client.guilds.cache.size === 0) {
        throw new Error('Cloudy is not connected to any guild; cannot register guild commands');
    }

    const failures = [];
    let successfulGuilds = 0;

    for (const guild of client.guilds.cache.values()) {
        try {
            await registerGuild(client, guild, commandsToRegister);
            successfulGuilds += 1;
        } catch (error) {
            failures.push(`${guild.name} (${guild.id}): ${error?.message || error}`);
            logger.error(`Failed command registration in ${guild.name} (${guild.id}):`, error);
        }
    }

    if (successfulGuilds === 0) {
        throw new Error(`Cloudy command registration failed in every connected guild. ${failures.join(' | ')}`);
    }

    client.commandSyncReady = true;
    client.registeredCommandCount = commandsToRegister.length;
    client.registeredGuildCount = successfulGuilds;

    if (failures.length > 0) {
        logger.warn(`Command sync succeeded in ${successfulGuilds} guild(s) but failed in ${failures.length}: ${failures.join(' | ')}`);
    }
}

export async function reloadCommand(client, commandName) {
    if (GROUPED_TOP_LEVEL_COMMANDS.has(commandName)) {
        return { success: false, message: `Command "${commandName}" is available under /music.` };
    }

    const command = client.commands.get(commandName);
    if (!command) return { success: false, message: `Command "${commandName}" not found` };

    try {
        const commandPath = path.resolve(command.filePath);
        const moduleUrl = pathToFileURL(commandPath);
        moduleUrl.searchParams.set('t', Date.now().toString());
        const newCommand = (await import(moduleUrl.href)).default;
        newCommand.category = command.category;
        newCommand.filePath = command.filePath;
        newCommand.adminOnly = !isPlayerCommand(newCommand.data?.name);
        client.commands.set(newCommand.data.name, newCommand);
        logger.info(`Reloaded command: ${newCommand.data.name}`);
        return { success: true, message: `Successfully reloaded command "${newCommand.data.name}"` };
    } catch (error) {
        logger.error(`Error reloading command "${commandName}":`, error);
        return { success: false, message: `Error reloading command: ${error.message}` };
    }
}
