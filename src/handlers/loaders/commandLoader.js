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
    const files = (await fs.readdir(directory, { withFileTypes: true }))
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const file of files) {
        const filePath = path.join(directory, file.name);
        if (file.isDirectory()) {
            // Keep the restored 100-command production set stable for now.
            // Leveling is loaded separately and must not push this direct guild
            // registration above Discord's 100 top-level command limit.
            if (file.name === 'modules' || file.name === 'Leveling') continue;
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

    logger.info(`[COMMAND_LOAD] Found ${commandFiles.length} command files.`);

    for (const filePath of commandFiles) {
        try {
            const normalizedPath = filePath.replace(/\\/g, '/');
            const category = path.basename(path.dirname(filePath));
            const commandModule = await import(pathToFileURL(filePath).href);
            const command = commandModule.default || commandModule;

            if (!command?.data || typeof command.execute !== 'function' || typeof command.data.toJSON !== 'function') {
                logger.warn(`[COMMAND_LOAD] ${normalizedPath} is missing data/execute/toJSON.`);
                continue;
            }

            const commandJson = command.data.toJSON();
            const commandName = commandJson.name;
            if (!commandName) {
                logger.warn(`[COMMAND_LOAD] ${normalizedPath} has no command name.`);
                continue;
            }

            if (uniqueCommandNames.has(commandName)) {
                logger.warn(`[COMMAND_LOAD] Duplicate /${commandName} ignored from ${normalizedPath}.`);
                continue;
            }
            uniqueCommandNames.add(commandName);

            command.category = command.category || category;
            command.filePath = normalizedPath;
            if (typeof command.adminOnly !== 'boolean') {
                command.adminOnly = !isPlayerCommand(commandName);
            }
            client.commands.set(commandName, command);

            const subcommands = getSubcommandInfo(commandJson);
            logger.info(
                `[COMMAND_LOAD] /${commandName} (${command.category})${subcommands.length ? ` -> ${subcommands.join(', ')}` : ''}`
            );
        } catch (error) {
            logger.error(`[COMMAND_LOAD] Failed ${filePath}:`, error);
        }
    }

    logger.info(`[COMMAND_LOAD] Loaded ${client.commands.size} unique top-level commands.`);
    return client.commands;
}

function collectCommandPayloads(client) {
    const commands = [];
    const registeredNames = new Set();

    for (const command of client.commands.values()) {
        if (!command?.data || typeof command.data.toJSON !== 'function') continue;

        const commandJson = JSON.parse(JSON.stringify(command.data.toJSON()));
        const commandName = commandJson.name;
        if (!commandName || registeredNames.has(commandName)) continue;
        registeredNames.add(commandName);

        // Preserve narrower command-specific permissions such as BanMembers or
        // ModerateMembers. Only add Administrator when the command itself has no
        // Discord default permission and Cloudy's visibility model marks it admin.
        if (command.adminOnly && !commandJson.default_member_permissions) {
            commandJson.default_member_permissions = '8';
        }

        commands.push(commandJson);
    }

    return commands;
}

function validateCommands(commands) {
    const errors = [];

    for (const cmd of commands) {
        if (!cmd.name || cmd.name.length > 32) errors.push(`Invalid command name: ${cmd.name || '<empty>'}`);
        if (!cmd.description || cmd.description.length > 100) errors.push(`Invalid description on /${cmd.name}`);

        const inspect = (options = [], prefix = cmd.name) => {
            for (const option of options) {
                if (option.name?.length > 32) errors.push(`Option name too long: ${prefix} ${option.name}`);
                if (option.description?.length > 100) errors.push(`Option description too long: ${prefix} ${option.name}`);
                for (const choice of option.choices || []) {
                    if (choice.name?.length > 100) errors.push(`Choice name too long: ${prefix} ${option.name}`);
                    if (typeof choice.value === 'string' && choice.value.length > 100) {
                        errors.push(`Choice value too long: ${prefix} ${option.name}`);
                    }
                }
                inspect(option.options || [], `${prefix} ${option.name}`);
            }
        };
        inspect(cmd.options || []);
    }

    if (errors.length) {
        errors.forEach((error) => logger.error(`[COMMAND_VALIDATION] ${error}`));
        throw new Error(`Command validation failed with ${errors.length} error(s)`);
    }
}

function verifyReturnedCommands(expected, returned, scope) {
    const returnedNames = new Set((returned || []).map((command) => command.name));
    const missing = expected.map((command) => command.name).filter((name) => !returnedNames.has(name));
    if (missing.length) throw new Error(`${scope} registration did not return: ${missing.join(', ')}`);

    const missingCritical = [...CRITICAL_COMMANDS].filter((name) => !returnedNames.has(name));
    if (missingCritical.length) {
        throw new Error(`${scope} is missing critical Cloudy commands: ${missingCritical.join(', ')}`);
    }
}

async function registerIndividually(client, route, commands, scopeLabel) {
    await client.rest.put(route, { body: [] });

    const registered = [];
    const failures = [];
    for (const command of commands) {
        try {
            const result = await client.rest.post(route, { body: command });
            registered.push(result);
            logger.info(`[COMMAND_SYNC] ${scopeLabel}: registered /${command.name}`);
        } catch (error) {
            failures.push({ name: command.name, error });
            logger.error(`[COMMAND_SYNC] ${scopeLabel}: failed /${command.name}:`, error);
        }
    }

    const returnedNames = new Set(registered.map((command) => command.name));
    const missingCritical = [...CRITICAL_COMMANDS].filter((name) => !returnedNames.has(name));
    if (missingCritical.length) {
        throw new Error(`${scopeLabel}: critical commands failed: ${missingCritical.join(', ')}`);
    }
    if (!registered.length) throw new Error(`${scopeLabel}: Discord rejected every command.`);

    if (failures.length) {
        logger.warn(`[COMMAND_SYNC] ${scopeLabel}: ${failures.length} non-critical failures: ${failures.map((f) => f.name).join(', ')}`);
    }
    return registered;
}

async function registerOneGuild(client, guild, commands) {
    const applicationId = client.user.id;
    const route = `/applications/${applicationId}/guilds/${guild.id}/commands`;
    const label = `${guild.name || 'guild'} (${guild.id})`;

    try {
        const result = await client.rest.put(route, { body: commands });
        verifyReturnedCommands(commands, result, label);
        logger.info(`[COMMAND_SYNC] SUCCESS ${label}: ${result.length} Cloudy commands registered.`);
        return { guildId: guild.id, guildName: guild.name, count: result.length, mode: 'bulk' };
    } catch (bulkError) {
        logger.error(`[COMMAND_SYNC] Bulk registration failed for ${label}; isolating commands:`, bulkError);
        const result = await registerIndividually(client, route, commands, label);
        verifyReturnedCommands(
            commands.filter((command) => result.some((registered) => registered.name === command.name)),
            result,
            label,
        );
        logger.info(`[COMMAND_SYNC] RECOVERED ${label}: ${result.length}/${commands.length} commands registered individually.`);
        return { guildId: guild.id, guildName: guild.name, count: result.length, mode: 'individual' };
    }
}

export async function registerCommands(client) {
    try {
        if (!client?.rest || !client?.user?.id || !client.isReady()) {
            throw new Error('Discord client is not READY for command registration');
        }

        const commands = collectCommandPayloads(client);
        if (commands.length >= COMMAND_COUNT_WARN_THRESHOLD) {
            logger.warn(`[COMMAND_SYNC] Command count is ${commands.length}/${MAX_COMMANDS}.`);
        }
        if (commands.length > MAX_COMMANDS) {
            throw new Error(`Loaded ${commands.length} commands; direct guild limit is ${MAX_COMMANDS}.`);
        }
        validateCommands(commands);

        const guilds = [...client.guilds.cache.values()];
        if (!guilds.length) throw new Error('Cloudy is not currently in any Discord guilds.');

        logger.info(
            `[COMMAND_SYNC] Hard reset: app=${client.user.id}, commands=${commands.length}, joinedGuilds=${guilds.length}`,
        );

        // Remove every stale global command left behind by old tokens/client IDs.
        // All production commands are registered immediately in the guild(s) the
        // authenticated Cloudy bot is actually connected to.
        await client.rest.put(`/applications/${client.user.id}/commands`, { body: [] });
        logger.info('[COMMAND_SYNC] Cleared stale global Cloudy commands.');

        const summaries = [];
        for (const guild of guilds) {
            summaries.push(await registerOneGuild(client, guild, commands));
        }

        client.commandRegistrationSummary = {
            synced: true,
            applicationId: client.user.id,
            totalCommands: commands.length,
            guilds: summaries,
            syncedAt: new Date().toISOString(),
        };

        logger.info(
            `[COMMAND_SYNC] COMPLETE: ${commands.length} commands registered in ${summaries.length} joined guild(s). ` +
            'No GUILD_ID lookup and no global propagation delay.',
        );
        return client.commandRegistrationSummary;
    } catch (error) {
        client.commandRegistrationSummary = {
            synced: false,
            error: error?.message || String(error),
            syncedAt: new Date().toISOString(),
        };
        logger.error('[COMMAND_SYNC] FATAL:', error);

        // Do not allow Railway to call a bot with no slash commands healthy.
        if (process.env.NODE_ENV === 'production') {
            setTimeout(() => process.exit(1), 250);
        }
        throw error;
    }
}

export async function reloadCommand(client, commandName) {
    const existing = client.commands.get(commandName);
    if (!existing) return { success: false, message: `Command "${commandName}" not found` };

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
