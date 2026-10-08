import { PermissionFlagsBits } from 'discord.js';

// The bot's permissions are not authority to read or write on a member's behalf.
export function canUseEmbedBuilderChannel(guild, member, channelOrId, { requireSend = false } = {}) {
    const channel = typeof channelOrId === 'object'
        ? channelOrId : guild?.channels?.cache?.get?.(String(channelOrId || ''));
    if (!guild?.id || !member || !channel) return false;
    const channelGuildId = channel.guildId || channel.guild?.id;
    if (channelGuildId && String(channelGuildId) !== String(guild.id)) return false;
    try {
        const permissions = channel.permissionsFor(member);
        const required = requireSend
            ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
            : [PermissionFlagsBits.ViewChannel];
        return Boolean(permissions?.has(required));
    } catch {
        return false;
    }
}

export function canAccessEmbedBuilderRecord(guild, member, record, options = {}) {
    if (!record || String(record.guildId || '') !== String(guild?.id || '')) return false;
    const related = [record, record.previewRecord, record.sourceRecord].filter(Boolean);
    return related.every(item => {
        if (item.guildId && String(item.guildId) !== String(guild.id)) return false;
        const channelIds = [...new Set([item.channelId, item.backingChannelId].filter(Boolean).map(String))];
        return channelIds.length > 0 && channelIds.every(id => canUseEmbedBuilderChannel(guild, member, id, options));
    });
}

export function filterEmbedBuilderRecords(guild, member, records, options = {}) {
    return (Array.isArray(records) ? records : []).filter(record => canAccessEmbedBuilderRecord(guild, member, record, options));
}
