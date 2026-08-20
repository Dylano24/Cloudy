import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { isPlayerCommand } from '../../config/playerCommands.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_COMMANDS = 100;
const DISCORD_TEXT_LIMIT = 100;

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
    const files = await fs.readdir(directory, { withFileTypes: true });

    for (const file of files) {
        const filePath = path.join(directory, file.name);
        if (file.isDirectory()) {
            // Only helper modules are skipped. Leveling contains real slash
            // commands (/rank, /leaderboard, /level, etc.) and must be loaded.
            if (file.name === 'modules') continue;
            await getAllFiles(filePath, fileList);
        } else if (file.name.endsWith('.js')) {
            fileList.push(filePath);
        }
    }

    return fileList;
}

function applyVisibilityRules(command) {
    const commandName = String(command?.data?.name || '').toLowerCase();
    command.adminOnly = !isPlayerCommand(commandName);

    // Old Cloudy rule: member commands are visible to normal members; every
    // other command is Administrator-only and therefore hidden from members
    // in Discord's slash-command picker.
    if (typeof command?.data?.setDefaultMemberPermissions === 'function') {
        command.data.setDefaultMemberPermissions(command.adminOnly ? 8n : null);
    }

    return command;
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
            const commandModule = await import(pathToFileURL(filePath).href);
            const command = commandModule.default || commandModule;

            if (!command?.data || typeof command.execute !== 'function') {
                logger.warn(`Command at ${normalizedPath} is missing required data or execute.`);
                continue;
            }

            command.category = category;
            command.filePath = normalizedPath;
            applyVisibilityRules(command);

            const primaryCommandName = command.data.name;
            if (!primaryCommandName || uniqueCommandNames.has(primaryCommandName)) {
                if (primaryCommandName) logger.warn(`Skipping duplicate command /${primaryCommandName}`);
                continue;
            }

            uniqueCommandNames.add(primaryCommandName);
            client.commands.set(primaryCommandName, command);

            const subcommands = getSubcommandInfo(command.data.toJSON());
            logger.info(
                `Loaded command: /${primaryCommandName} (${command.adminOnly ? 'admin' : 'member'}) from ${normalizedPath}`
            );
            if (subcommands.length) logger.info(`  - Subcommands: ${subcommands.join(', ')}`);
        } catch (error) {
            logger.error(`Error loading command from ${filePath}:`, error);
        }
    }

    logger.info(`Loaded ${client.commands.size} unique slash commands`);
    return client.commands;
}

function trimText(value) {
    if (typeof value !== 'string') return value;
    return value.length > DISCORD_TEXT_LIMIT ? value.slice(0, DISCORD_TEXT_LIMIT) : value;
}

function sanitizeOption(option) {
    if (!option || typeof option !== 'object') return option;
    const result = { ...option };

    if (typeof result.description === 'string') result.description = trimText(result.description);
    if (Array.isArray(result.choices)) {
        result.choices = result.choices.map((choice) => ({
            ...choice,
            name: trimText(choice?.name),
            value: typeof choice?.value === 'string' ? trimText(choice.value) : choice?.value,
        }));
    }
    if (Array.isArray(result.options)) result.options = result.options.map(sanitizeOption);
    return result;
}

function collectCommandPayloads(client) {
    const payloads = [];
    const seen = new Set();

    for (const command of client.commands.values()) {
        if (!command?.data || typeof command.data.toJSON !== 'function') continue;

        const payload = command.data.toJSON();
        if (!payload?.name || seen.has(payload.name)) continue;
        seen.add(payload.name);

        payload.description = trimText(payload.description);
        if (Array.isArray(payload.options)) payload.options = payload.options.map(sanitizeOption);
        payload.default_member_permissions = command.adminOnly ? '8' : null;
        payloads.push(payload);
    }

    // Keep /help first. The normal case is below Discord's 100-command limit.
    payloads.sort((a, b) => {
        if (a.name === 'help') return -1;
        if (b.name === 'help') return 1;
        return a.name.localeCompare(b.name);
    });

    if (payloads.length > MAX_COMMANDS) {
        logger.warn(`Discord allows ${MAX_COMMANDS} chat-input commands per scope; ${payloads.length} loaded. Keeping the first ${MAX_COMMANDS}.`);
    }

    return payloads.slice(0, MAX_COMMANDS);
}

async function putCommands(client, route, payloads, label) {
    await client.rest.put(route, { body: payloads });
    logger.info(`Successfully registered ${payloads.length} ${label} commands`);
}

export async function registerCommands(client, options = {}) {
    const resolvedClientId = client.user?.id || options.clientId;
    if (!resolvedClientId) throw new Error('Could not resolve authenticated Discord application ID');
    if (!client.rest) throw new Error('Discord REST client is not available');

    const payloads = collectCommandPayloads(client);
    if (!payloads.length) throw new Error('No slash commands were loaded');

    // Immediate registration for the configured server.
    const configuredGuildId = process.env.GUILD_ID || process.env.BOTPROFILE_GUILD_ID;
    if (configuredGuildId) {
        try {
            await putCommands(
                client,
                `/applications/${resolvedClientId}/guilds/${configuredGuildId}/commands`,
                payloads,
                'guild'
            );
        } catch (error) {
            logger.warn(`Configured guild command registration failed for ${configuredGuildId}: ${error?.message || error}`);
        }
    }

    // Keep global commands in sync as a fallback. ClientReady performs another
    // guild-specific repair for every guild the bot is actually connected to.
    try {
        await putCommands(
            client,
            `/applications/${resolvedClientId}/commands`,
            payloads,
            'global'
        );
    } catch (error) {
        logger.warn(`Global command registration failed; guild sync will still run: ${error?.message || error}`);
    }
}

export async function reloadCommand(client, commandName) {
    const current = client.commands.get(commandName);
    if (!current) return { success: false, message: `Command "${commandName}" not found` };

    try {
        const moduleUrl = pathToFileURL(path.resolve(current.filePath));
        moduleUrl.searchParams.set('t', Date.now().toString());
        const fresh = (await import(moduleUrl.href)).default;
        fresh.category = current.category;
        fresh.filePath = current.filePath;
        applyVisibilityRules(fresh);
        client.commands.set(fresh.data.name, fresh);
        logger.info(`Reloaded command: ${fresh.data.name}`);
        return { success: true, message: `Successfully reloaded command "${fresh.data.name}"` };
    } catch (error) {
        logger.error(`Error reloading command "${commandName}":`, error);
        return { success: false, message: `Error reloading command: ${error.message}` };
    }
}
