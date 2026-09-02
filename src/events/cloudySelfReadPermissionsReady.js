import {
    ChannelType,
    Events,
    PermissionFlagsBits,
} from 'discord.js';
import { logger } from '../utils/logger.js';

const TARGET_GUILD_ID = '1532882647838228723';
const REQUIRED_READ_PERMISSIONS = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
];

function readableChannel(channel) {
    return channel?.type === ChannelType.GuildText
        || channel?.type === ChannelType.GuildAnnouncement;
}

function hasRequiredReadPermissions(channel, member) {
    const permissions = channel.permissionsFor(member);
    return Boolean(permissions?.has(PermissionFlagsBits.ViewChannel)
        && permissions?.has(PermissionFlagsBits.ReadMessageHistory));
}

function canRepairPermissions(channel, member) {
    const permissions = channel.permissionsFor(member);
    return Boolean(
        permissions?.has(PermissionFlagsBits.Administrator)
        || permissions?.has(PermissionFlagsBits.ManageRoles),
    );
}

async function ensureChannelReadPermissions(channel, member) {
    if (!readableChannel(channel) || !channel.permissionOverwrites?.edit) return false;
    if (hasRequiredReadPermissions(channel, member)) return false;

    if (!canRepairPermissions(channel, member)) {
        logger.warn(
            `[EMBED_BUILDER] Cannot restore read access for #${channel.name} (${channel.id}): `
            + 'Cloudy needs Administrator or Manage Roles in that channel.',
        );
        return false;
    }

    await channel.permissionOverwrites.edit(
        member.id,
        {
            ViewChannel: true,
            ReadMessageHistory: true,
        },
        { reason: 'Restore Cloudy Embed Builder read access' },
    );

    logger.info(`[EMBED_BUILDER] Restored Cloudy read access for #${channel.name} (${channel.id}).`);
    return true;
}

async function repairGuild(client) {
    const guild = client.guilds.cache.get(TARGET_GUILD_ID)
        || await client.guilds.fetch(TARGET_GUILD_ID).catch(() => null);
    if (!guild) {
        logger.warn(`[EMBED_BUILDER] Target guild ${TARGET_GUILD_ID} is not available to Cloudy.`);
        return;
    }

    const member = guild.members.me
        || await guild.members.fetchMe().catch(() => null);
    if (!member) {
        logger.warn('[EMBED_BUILDER] Could not resolve Cloudy guild member for permission repair.');
        return;
    }

    let repaired = 0;
    for (const channel of guild.channels.cache.values()) {
        try {
            if (await ensureChannelReadPermissions(channel, member)) repaired += 1;
        } catch (error) {
            logger.warn(
                `[EMBED_BUILDER] Failed to restore read access for #${channel?.name || channel?.id || 'unknown'}: `
                + `${error?.message || error}`,
            );
        }
    }

    logger.info(`[EMBED_BUILDER] Permission check complete for ${TARGET_GUILD_ID}; repaired ${repaired} channel(s).`);
}

export default {
    name: Events.ClientReady,
    once: true,

    execute(client) {
        const timer = setTimeout(() => {
            repairGuild(client).catch(error => {
                logger.error('[EMBED_BUILDER] Permission repair failed:', error);
            });
        }, 1_500);
        timer.unref?.();
    },
};
