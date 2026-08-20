import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { isPlayerCommand } from '../../config/playerCommands.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_COMMANDS_PER_SCOPE = 100;

// Keep the commands the Cloudy server relies on most in the guild scope so
// they update immediately and never disappear behind Discord's global cache.
// This changes registration only; the command implementations remain exactly
// the restored 06:00 versions.
const GUILD_PRIORITY_COMMANDS = new Set([
    'help',
    'ban',
    'unban',
    'kick',
    'timeout',
    'untimeout',
    'warn',
    'massban',
    'masskick',
    'purge',
    'lock',
    'unlock',
    'cases',
    'usernotes',
    'ticket',
    'claim',
    'close',
    'priority',
    'report',
    'reports',
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
            // Preserve the exact 06:00 loader behavior.
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

function collectCommandEntries(client) {
    const entries = [];
    const registeredNames = new Set();

    for (const command of client.commands.values()) {
        if (!command.data || typeof command.data.toJSON !== 'function') {
            logger.warn('Command missing data or toJSON method');
            continue;
        }

        const name = command.data.name;
        if (registeredNames.has(name)) {
            logger.warn(`Skipping duplicate command during registration: /${name}`);
            continue;
        }
        registeredNames.add(name);

        const payload = command.data.toJSON();
        // Preserve the old 06:00 permission behavior.
        if (command.adminOnly && !payload.default_member_permissions) {
            payload.default_member_permissions = '8';
        }

        entries.push({
            name,
            payload,
            adminOnly: Boolean(command.adminOnly),
            category: command.category || 'Unknown',
        });
    }

    return entries;
}

function validatePayloads(payloads, scopeName) {
    const errors = [];

    if (payloads.length > MAX_COMMANDS_PER_SCOPE) {
        errors.push(`${scopeName} has ${payloads.length} top-level commands; Discord allows ${MAX_COMMANDS_PER_SCOPE}`);
    }

    for (const cmd of payloads) {
        if (cmd.name?.length > 32) errors.push(`/${cmd.name} name is longer than 32 characters`);
        if (cmd.description?.length > 100) errors.push(`/${cmd.name} description is longer than 100 characters`);

        for (const option of cmd.options || []) {
            if (option.name?.length > 32) errors.push(`/${cmd.name} option ${option.name} is longer than 32 characters`);
            if (option.description?.length > 100) errors.push(`/${cmd.name} option ${option.name} description is longer than 100 characters`);

            for (const subOption of option.options || []) {
                if (subOption.name?.length > 32) errors.push(`/${cmd.name} nested option ${subOption.name} is longer than 32 characters`);
                if (subOption.description?.length > 100) errors.push(`/${cmd.name} nested option ${subOption.name} description is longer than 100 characters`);
            }
        }
    }

    if (errors.length > 0) {
        errors.forEach((error) => logger.error(`[COMMAND_VALIDATION] ${error}`));
        throw new Error(`Command validation failed for ${scopeName} with ${errors.length} error(s)`);
    }
}

function partitionCommands(entries) {
    if (entries.length > MAX_COMMANDS_PER_SCOPE * 2) {
        throw new Error(
            `Cloudy has ${entries.length} unique top-level commands. ` +
            `The combined global + guild capacity is ${MAX_COMMANDS_PER_SCOPE * 2}.`
        );
    }

    const guildEntries = [];
    const globalEntries = [];
    const assigned = new Set();

    const addGuild = (entry) => {
        if (assigned.has(entry.name) || guildEntries.length >= MAX_COMMANDS_PER_SCOPE) return false;
        guildEntries.push(entry);
        assigned.add(entry.name);
        return true;
    };

    const addGlobal = (entry) => {
        if (assigned.has(entry.name) || globalEntries.length >= MAX_COMMANDS_PER_SCOPE) return false;
        globalEntries.push(entry);
        assigned.add(entry.name);
        return true;
    };

    // 1. Critical legacy Cloudy commands are always guild-scoped and immediate.
    for (const entry of entries) {
        if (GUILD_PRIORITY_COMMANDS.has(entry.name)) addGuild(entry);
    }

    // 2. Keep the rest of the administration suite in the guild when possible.
    for (const entry of entries) {
        if (entry.adminOnly) addGuild(entry);
    }

    // 3. Member commands prefer global scope.
    for (const entry of entries) {
        if (!entry.adminOnly) addGlobal(entry);
    }

    // 4. If either preferred scope filled up, place remaining unique commands
    //    into whichever scope still has capacity. Nothing is silently dropped.
    for (const entry of entries) {
        if (assigned.has(entry.name)) continue;
        if (!addGlobal(entry) && !addGuild(entry)) {
            throw new Error(`No Discord command capacity left for /${entry.name}`);
        }
    }

    if (assigned.size !== entries.length) {
        throw new Error(`Registration partition lost commands: expected ${entries.length}, assigned ${assigned.size}`);
    }

    return { guildEntries, globalEntries };
}

async function registerCommandScopes(client, clientId, guildId, entries) {
    if (!clientId) throw new Error('CLIENT_ID is required for slash command registration');
    if (!guildId) throw new Error('GUILD_ID is required for Cloudy guild command registration');
    if (!client.rest) throw new Error('Discord REST client is not available for slash command registration');

    const { guildEntries, globalEntries } = partitionCommands(entries);
    const guildPayloads = guildEntries.map((entry) => entry.payload);
    const globalPayloads = globalEntries.map((entry) => entry.payload);

    validatePayloads(guildPayloads, 'Cloudy guild scope');
    validatePayloads(globalPayloads, 'global scope');

    logger.info(
        `[COMMAND_REGISTRATION] total=${entries.length} guild=${guildPayloads.length} global=${globalPayloads.length}`
    );

    // PUT replaces the complete command list for each scope, so old/stale copies
    // are removed rather than accumulating duplicate /help or moderation entries.
    const guildResult = await client.rest.put(
        `/applications/${clientId}/guilds/${guildId}/commands`,
        { body: guildPayloads }
    );

    const globalResult = await client.rest.put(
        `/applications/${clientId}/commands`,
        { body: globalPayloads }
    );

    const guildNames = new Set(guildResult.map((command) => command.name));
    const globalNames = new Set(globalResult.map((command) => command.name));

    for (const entry of entries) {
        if (!guildNames.has(entry.name) && !globalNames.has(entry.name)) {
            throw new Error(`Discord did not return registered command /${entry.name}`);
        }
    }

    const requiredImmediate = ['help', 'ban', 'unban', 'kick', 'timeout', 'untimeout', 'ticket'];
    const missingImmediate = requiredImmediate.filter((name) =>
        entries.some((entry) => entry.name === name) && !guildNames.has(name)
    );

    if (missingImmediate.length > 0) {
        throw new Error(`Critical Cloudy guild commands missing after sync: ${missingImmediate.join(', ')}`);
    }

    logger.info(
        `Cloudy command sync complete: ${guildResult.length} immediate guild commands + ` +
        `${globalResult.length} global commands; no command was truncated.`
    );
}

export async function registerCommands(client, options = {}) {
    const clientId = options.clientId || client.user?.id || null;
    const guildId =
        process.env.GUILD_ID ||
        process.env.BOTPROFILE_GUILD_ID ||
        '1532882647838228723';

    try {
        const entries = collectCommandEntries(client);
        await registerCommandScopes(client, clientId, guildId, entries);
    } catch (error) {
        logger.error('Error registering commands:', error);
        throw error;
    }
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
