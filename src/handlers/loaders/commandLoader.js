import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';
import { logger } from '../../utils/logger.js';
import botConfig from '../../config/bot.js';
import { isPlayerCommand } from '../../config/playerCommands.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_COMMANDS = 100;
const COMMAND_COUNT_WARN_THRESHOLD = 90;
const CRITICAL_COMMANDS = new Set([
    'help',
    'ban',
    'unban',
    'kick',
    'timeout',
    'untimeout',
    'warn',
    'ticket',
]);

function getSubcommandInfo(commandData) {
    const subcommands = [];

    if (commandData.options) {
        for (const option of commandData.options) {
            if (option.type === 1) {
                subcommands.push(option.name);
            } else if (option.type === 2 && option.options) {
                for (const subOption of option.options) {
                    if (subOption.type === 1) {
                        subcommands.push(`${option.name}/${subOption.name}`);
                    }
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
            if (file.name === 'modules' || file.name === 'Leveling') {
                continue;
            }
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
            const commandDir = path.dirname(filePath);
            const category = path.basename(commandDir);
            const commandModule = await import(`file://${filePath}`);
            const command = commandModule.default || commandModule;

            if (!command.data || !command.execute) {
                logger.warn(`Command at ${filePath} is missing required "data" or "execute" property.`);
                continue;
            }

            command.category = category;
            command.filePath = normalizedPath;

            const primaryCommandName = command.data.name;
            command.adminOnly = !isPlayerCommand(primaryCommandName);

            if (!uniqueCommandNames.has(primaryCommandName)) {
                uniqueCommandNames.add(primaryCommandName);
                client.commands.set(primaryCommandName, command);
            } else {
                logger.warn(`Duplicate command /${primaryCommandName} ignored from ${normalizedPath}`);
            }

            const subcommands = getSubcommandInfo(command.data.toJSON());
            logger.info(`Loaded command: ${primaryCommandName} from ${normalizedPath} (category: ${category})`);
            if (subcommands.length > 0) {
                logger.info(`  - Subcommands: ${subcommands.join(', ')}`);
            }
        } catch (error) {
            logger.error(`Error loading command from ${filePath}:`, error);
        }
    }

    logger.info(`Loaded ${client.commands.size} commands`);
    return client.commands;
}

function collectCommandPayloads(client) {
    const commands = [];
    const registeredNames = new Set();

    for (const command of client.commands.values()) {
        if (!command.data || typeof command.data.toJSON !== 'function') {
            logger.warn('Command missing data or toJSON method');
            continue;
        }

        const commandJson = command.data.toJSON();
        const commandName = commandJson.name;
        if (!commandName || registeredNames.has(commandName)) {
            continue;
        }

        registeredNames.add(commandName);

        // Discord controls visibility before execution. Admin commands are only
        // shown to members with Administrator; the server owner also has this
        // effective permission. Player commands remain visible to members.
        if (command.adminOnly && !commandJson.default_member_permissions) {
            commandJson.default_member_permissions = '8';
        }

        commands.push(commandJson);
    }

    return commands;
}

function validateCommands(commands) {
    const validationErrors = [];

    for (const cmd of commands) {
        if (!cmd.name || cmd.name.length > 32) {
            validationErrors.push(`Invalid command name: ${cmd.name || '<empty>'}`);
        }
        if (!cmd.description || cmd.description.length > 100) {
            validationErrors.push(`Invalid description on /${cmd.name}`);
        }

        const inspectOptions = (options = [], prefix = cmd.name) => {
            for (const option of options) {
                if (option.name && option.name.length > 32) {
                    validationErrors.push(`Option name too long: ${prefix} ${option.name}`);
                }
                if (option.description && option.description.length > 100) {
                    validationErrors.push(`Option description too long: ${prefix} ${option.name}`);
                }
                if (Array.isArray(option.options)) {
                    inspectOptions(option.options, `${prefix} ${option.name}`);
                }
                if (Array.isArray(option.choices)) {
                    for (const choice of option.choices) {
                        if (choice.name && choice.name.length > 100) {
                            validationErrors.push(`Choice name too long: ${prefix} ${option.name}`);
                        }
                        if (typeof choice.value === 'string' && choice.value.length > 100) {
                            validationErrors.push(`Choice value too long: ${prefix} ${option.name}`);
                        }
                    }
                }
            }
        };

        inspectOptions(cmd.options);
    }

    if (validationErrors.length > 0) {
        validationErrors.forEach((error) => logger.error(`[COMMAND_VALIDATION] ${error}`));
        throw new Error(`Command validation failed with ${validationErrors.length} error(s)`);
    }
}

function getGuildId() {
    return String(
        process.env.GUILD_ID ||
        process.env.BOTPROFILE_GUILD_ID ||
        botConfig.commands?.testGuildId ||
        ''
    ).trim();
}

function verifyReturnedCommands(expected, returned, scope) {
    const returnedNames = new Set((returned || []).map((command) => command.name));
    const missing = expected
        .map((command) => command.name)
        .filter((name) => !returnedNames.has(name));

    if (missing.length > 0) {
        throw new Error(`${scope} registration did not return: ${missing.join(', ')}`);
    }
}

async function registerIndividually(client, route, commands) {
    await client.rest.put(route, { body: [] });

    const registered = [];
    const failures = [];

    for (const command of commands) {
        try {
            const result = await client.rest.post(route, { body: command });
            registered.push(result);
            logger.info(`[COMMAND_SYNC] Registered /${command.name}`);
        } catch (error) {
            failures.push({ name: command.name, error });
            logger.error(`[COMMAND_SYNC] Failed to register /${command.name}:`, error);
        }
    }

    const failedNames = new Set(failures.map((failure) => failure.name));
    const missingCritical = [...CRITICAL_COMMANDS].filter((name) => failedNames.has(name));

    if (missingCritical.length > 0) {
        throw new Error(`Critical Cloudy commands failed registration: ${missingCritical.join(', ')}`);
    }

    if (registered.length === 0) {
        throw new Error('Discord rejected every Cloudy slash command');
    }

    if (failures.length > 0) {
        logger.warn(
            `[COMMAND_SYNC] ${failures.length} non-critical command(s) failed: ${failures.map((failure) => failure.name).join(', ')}`
        );
    }

    return registered;
}

async function registerGuildCommands(client, commands) {
    const clientId = client.user?.id;
    const guildId = getGuildId();

    if (!clientId) {
        throw new Error('Authenticated Discord application ID is unavailable');
    }
    if (!guildId) {
        throw new Error('GUILD_ID is required for Cloudy slash command registration');
    }
    if (!client.rest) {
        throw new Error('Discord REST client is not available for slash command registration');
    }

    if (commands.length >= COMMAND_COUNT_WARN_THRESHOLD) {
        logger.warn(`Command count (${commands.length}) is near Discord's ${MAX_COMMANDS} guild command limit`);
    }
    if (commands.length > MAX_COMMANDS) {
        throw new Error(
            `Cloudy has ${commands.length} top-level commands, but Discord allows only ${MAX_COMMANDS} guild slash commands. Refusing to silently truncate commands.`
        );
    }

    validateCommands(commands);

    const globalRoute = `/applications/${clientId}/commands`;
    const guildRoute = `/applications/${clientId}/guilds/${guildId}/commands`;

    // Remove stale global commands so Discord never shows duplicate/old copies.
    await client.rest.put(globalRoute, { body: [] });
    logger.info('[COMMAND_SYNC] Cleared stale global Cloudy commands');

    try {
        const result = await client.rest.put(guildRoute, { body: commands });
        verifyReturnedCommands(commands, result, `Guild ${guildId}`);
        logger.info(`[COMMAND_SYNC] Successfully registered ${result.length} Cloudy commands directly in guild ${guildId}`);
        return result;
    } catch (error) {
        logger.error('[COMMAND_SYNC] Bulk guild registration failed; isolating invalid command(s) one by one:', error);
        const result = await registerIndividually(client, guildRoute, commands);
        logger.info(`[COMMAND_SYNC] Individually registered ${result.length}/${commands.length} Cloudy commands in guild ${guildId}`);
        return result;
    }
}

export async function registerCommands(client) {
    const commands = collectCommandPayloads(client);
    logger.info(`[COMMAND_SYNC] Preparing ${commands.length} Cloudy slash commands for direct guild registration`);
    return registerGuildCommands(client, commands);
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

        client.commands.set(commandName, newCommand);
        logger.info(`Reloaded command: ${commandName}`);
        return { success: true, message: `Successfully reloaded command "${commandName}"` };
    } catch (error) {
        logger.error(`Error reloading command "${commandName}":`, error);
        return { success: false, message: `Error reloading command: ${error.message}` };
    }
}
