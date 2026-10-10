import {
    ChannelType,
    Events,
    PermissionFlagsBits,
} from 'discord.js';
import { logger, startupLog } from '../utils/logger.js';
import { inspectCloudyChannelLinks, formatCloudyChannelAudit } from '../services/cloudyChannelAuditService.js';
import { fetchGuildChannels } from '../utils/guildChannelFetch.js';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';

const TARGET_GUILD_ID = '1532882647838228723';
const REQUIRED_READ_PERMISSIONS = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
];
const PATCH_DESTINATIONS = Object.freeze([
    { key: 'rustPatch', name: 'Rust patch notes' },
    { key: 'nitradoPatch', name: 'Nitrado Rust updates' },
]);
const REQUIRED_POST_PERMISSIONS = [
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
];
// Both Ready and GuildCreate can run during a reconnect; never duplicate REST edits.
const pendingRecovery = new WeakMap();

function readableChannel(channel) {
    return channel?.type === ChannelType.GuildText
        || channel?.type === ChannelType.GuildAnnouncement;
}

function canRepairPermissions(channel, member) {
    const permissions = channel.permissionsFor(member);
    return Boolean(
        permissions?.has(PermissionFlagsBits.Administrator)
        || permissions?.has(PermissionFlagsBits.ManageRoles),
    );
}

function missingPermissions(channel, member, patchDestination = false) {
    const permissions = channel.permissionsFor(member);
    const required = patchDestination
        ? [...REQUIRED_READ_PERMISSIONS, ...REQUIRED_POST_PERMISSIONS]
        : REQUIRED_READ_PERMISSIONS;
    return required.filter(permission => !permissions?.has(permission));
}

async function ensureChannelPermissions(channel, member, patchDestination = false) {
    if (!readableChannel(channel) || !channel.permissionOverwrites?.edit) return false;
    const missing = missingPermissions(channel, member, patchDestination);
    if (missing.length === 0) return false;

    if (!canRepairPermissions(channel, member)) {
        logger.warn(
            `[CHANNEL_RECOVERY] Missing ${patchDestination ? 'read/post' : 'read'} permissions in #${channel.name} (${channel.id}). `
            + 'Cloudy needs Administrator or Manage Roles to repair these channel overwrites.',
        );
        return false;
    }

    const overwrites = {
        ViewChannel: true,
        ReadMessageHistory: true,
        ...(patchDestination ? {
            SendMessages: true,
            EmbedLinks: true,
        } : {}),
    };

    await channel.permissionOverwrites.edit(
        member.id,
        overwrites,
        { reason: patchDestination
            ? 'Restore Cloudy Rust update post access after bot rejoin'
            : 'Restore Cloudy Embed Builder read access' },
    );

    logger.info(
        `[CHANNEL_RECOVERY] Restored ${patchDestination ? 'read and post' : 'read'} permissions in #${channel.name} (${channel.id}).`,
    );
    return true;
}

async function inspectAndRepairGuild(client) {
    const guild = client.guilds.cache.get(TARGET_GUILD_ID)
        || await client.guilds.fetch(TARGET_GUILD_ID).catch(() => null);
    if (!guild) {
        logger.warn(`[CHANNEL_RECOVERY] Target guild ${TARGET_GUILD_ID} is not available to Cloudy.`);
        return { found: false, repaired: 0, missingPatchChannels: 2 };
    }

    const member = guild.members.me
        || await guild.members.fetchMe().catch(() => null);
    if (!member) {
        logger.warn('[CHANNEL_RECOVERY] Could not resolve Cloudy guild member for permission recovery.');
        return { found: true, repaired: 0, missingPatchChannels: 2 };
    }

    // Refresh Discord's channel list after the bot was removed and added again.
    // Never create, rename, relocate, delete or repost any channel or message.
    await fetchGuildChannels(guild).catch(error => {
        logger.warn(`[CHANNEL_RECOVERY] Could not refresh guild channels: ${error?.message || error}`);
    });

    // Summarize actual Discord channel visibility without touching saved content.
    // startupLog remains visible on installations configured with LOG_LEVEL=warn.
    startupLog('[CHANNEL_AUDIT] Before permission recovery: ' + formatCloudyChannelAudit(inspectCloudyChannelLinks(guild, member)));

    const patchChannelIds = new Set();
    let missingPatchChannels = 0;
    for (const destination of PATCH_DESTINATIONS) {
        const channel = await resolveCloudyChannel(client, destination.key, { guild, textOnly: true });
        if (!channel || !readableChannel(channel)) {
            missingPatchChannels += 1;
            logger.warn(
                `[CHANNEL_RECOVERY] ${destination.name} channel cannot be found or viewed in guild ${TARGET_GUILD_ID}. `
                + 'Verify the original channel or a matching named text channel and Cloudy View Channel permission.',
            );
            continue;
        }
        patchChannelIds.add(channel.id);
        logger.info(`[CHANNEL_RECOVERY] ${destination.name} resolved to #${channel.name} (${channel.id}).`);
    }

    let repaired = 0;
    for (const channel of guild.channels.cache.values()) {
        try {
            if (await ensureChannelPermissions(channel, member, patchChannelIds.has(channel.id))) {
                repaired += 1;
            }
        } catch (error) {
            logger.warn(
                `[CHANNEL_RECOVERY] Failed to repair #${channel?.name || channel?.id || 'unknown'}: `
                + `${error?.message || error}`,
            );
        }
    }

    logger.info(
        `[CHANNEL_RECOVERY] Guild ${TARGET_GUILD_ID} complete; permissions repaired in ${repaired} channel(s); `
        + `patch destinations unavailable: ${missingPatchChannels}.`,
    );
    startupLog('[CHANNEL_AUDIT] After permission recovery: ' + formatCloudyChannelAudit(inspectCloudyChannelLinks(guild, member)));
    startupLog('[CHANNEL_RECOVERY] Complete: repaired ' + repaired + ' existing channel permission sets; patch destinations unavailable ' + missingPatchChannels + '.');
    return { found: true, repaired, missingPatchChannels };
}

export function repairGuild(client) {
    if (pendingRecovery.has(client)) return pendingRecovery.get(client);
    const task = inspectAndRepairGuild(client).finally(() => {
        if (pendingRecovery.get(client) === task) pendingRecovery.delete(client);
    });
    pendingRecovery.set(client, task);
    return task;
}

export default {
    name: Events.ClientReady,
    once: true,

    execute(client) {
        const timer = setTimeout(() => {
            repairGuild(client).catch(error => {
                logger.error('[CHANNEL_RECOVERY] Permission recovery failed:', error);
            });
        }, 1_500);
        timer.unref?.();
    },
};
