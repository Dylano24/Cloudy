import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection, PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { isPlayerCommand } from '../../config/playerCommands.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_COMMANDS_PER_SCOPE = 100;

function getSubcommandInfo(commandData) {
    const subcommands = [];

    for (const option of commandData?.options || []) {
        if (option.type === 1) {
            subcommands.push(option.name);
        } else if (option.type === 2) {
            for (const subOption of option.options || []) {
                if (subOption.type === 1) {
                    subcommands.push(`${option.name}/${subOption.name}`);
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
            // "modules" contains implementation helpers, not top-level commands.
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
            if (!commandName) {
                logger.warn(`Command at ${filePath} has no command name`);
                continue;
            }

            if (uniqueCommandNames.has(commandName)) {
                logger.warn(`Skipping duplicate top-level command /${commandName} from ${normalizedPath}`);
                continue;
            }

            uniqueCommandNames.add(commandName);
            command.category = category;
            command.filePath = normalizedPath;
            command.adminOnly = !isPlayerCommand(commandName);
            client.commands.set(commandName, command);

            const subcommands = getSubcommandInfo(command.data.toJSON());
            logger.info(`Loaded /${commandName} (${category})${subcommands.length ? ` -> ${subcommands.join(', ')}` : ''}`);
        } catch (error) {
            logger.error(`Error loading command from ${filePath}:`, error);
        }
    }

    logger.info(`Loaded ${client.commands.size} unique top-level commands`);
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

        for (const option of cmd.options || []) {
            if (option.name?.length > 32) errors.push(`/${cmd.name} option ${option.name} exceeds 32 characters`);
            if (option.description?.length > 100) errors.push(`/${cmd.name} option ${option.name} description exceeds 100 characters`);

            for (const subOption of option.options || []) {
                if (subOption.name?.length > 32) errors.push(`/${cmd.name} sub-option ${subOption.name} exceeds 32 characters`);
                if (subOption.description?.length > 100) errors.push(`/${cmd.name} sub-option ${subOption.name} description exceeds 100 characters`);
            }
        }
    }

    if (errors.length) {
        errors.forEach((error) => logger.error(`[COMMAND_VALIDATION] ${error}`));
        throw new Error(`Command validation failed for ${scopeName} with ${errors.length} error(s)`);
    }
}

function collectCommandPayloads(client) {
    const memberCommands = [];
    const adminCommands = [];

    for (const command of client.commands.values()) {
        if (!command.data || typeof command.data.toJSON !== 'function') continue;

        const payload = command.data.toJSON();

        if (command.adminOnly) {
            // Admin suite is guild-scoped and hidden from normal members.
            // Guild owners satisfy Administrator automatically.
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
    if (!authenticatedId) {
        throw new Error('Cannot register slash commands before Discord login is ready');
    }

    if (configuredClientId && String(configuredClientId) !== String(authenticatedId)) {
        logger.warn(
            `[COMMAND_REGISTRATION] Ignoring mismatched configured CLIENT_ID ${configuredClientId}; ` +
            `authenticated Discord application is ${authenticatedId}`
        );
    }

    return authenticatedId;
}

async function putGlobalCommands(client, applicationId, memberCommands) {
    validateCommands(memberCommands, 'global member scope');

    const result = await client.rest.put(
        `/applications/${applicationId}/commands`,
        { body: memberCommands },
    );

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

    logger.info(`Registered ${result.length} Cloudy admin commands in guild ${guildId}`);
    return result;
}

export async function registerCommands(client, options = {}) {
    const applicationId = getAuthenticatedApplicationId(client, options.clientId || null);
    const { memberCommands, adminCommands } = collectCommandPayloads(client);

    logger.info(
        `[COMMAND_REGISTRATION] application=${applicationId} ` +
        `member=${memberCommands.length} admin=${adminCommands.length} guilds=${client.guilds.cache.size}`
    );

    validateCommands(memberCommands, 'global member scope');
    validateCommands(adminCommands, 'guild admin scope');

    await putGlobalCommands(client, applicationId, memberCommands);

    // Admin commands are kept out of the global 100-command pool and registered
    // instantly in every guild where this exact bot token is actually present.
    for (const guild of client.guilds.cache.values()) {
        await registerGuildCommandsForGuild(client, guild.id, { clientId: applicationId });
    }

    if (client.guilds.cache.size === 0) {
        logger.warn('[COMMAND_REGISTRATION] Bot is not currently in any guild; admin commands will register when it joins one');
    }

    logger.info('[COMMAND_REGISTRATION] Slash command sync completed successfully');
}

export async function reloadCommand(client, commandName) {
    const command = client.commands.get(commandName);

    if (!command) {
        return { success: false, message: `Command "${commandName}" not found` };
    }

    try {
        const commandPath = path.resolve(command.filePath);
        const moduleUrl = pathToFileURL(commandPath);
        moduleUrl.searchParams.set('t', Date.now().toString());
        const newCommand = (await import(moduleUrl.href)).default;

        newCommand.category = command.category;
        newCommand.filePath = command.filePath;
        newCommand.adminOnly = !isPlayerCommand(newCommand.data?.name);
        client.commands.set(commandName, newCommand);

        logger.info(`Reloaded command: ${commandName}`);
        return { success: true, message: `Successfully reloaded command "${commandName}"` };
    } catch (error) {
        logger.error(`Error reloading command "${commandName}":`, error);
        return { success: false, message: `Error reloading command: ${error.message}` };
    }
}
