import { MessageFlags } from 'discord.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from './cloudyBrandingService.js';
import { registerCloudyEmbedMessage } from './embedRegistryService.js';

const INTERNAL_TITLES = new Set([
    'message builder',
    'modify embed',
    'embed loaded',
    'changes saved',
    'could not load embeds',
]);

function isUsableMessage(message, botUserId) {
    if (!message?.guildId || message.author?.id !== botUserId || !message.embeds?.length) return false;
    if (message.flags?.has?.(MessageFlags.Ephemeral)) return false;
    if (message.interaction || message.interactionMetadata) return false;
    return message.embeds.some(embed => !INTERNAL_TITLES.has(String(embed?.title || '').trim().toLowerCase()));
}

function isBuilderMarked(message) {
    return message.embeds?.some(embed =>
        String(embed?.footer?.text || '').endsWith(MESSAGE_BUILDER_FOOTER_MARKER),
    );
}

function hasComponents(message) {
    return Array.isArray(message?.components) && message.components.length > 0;
}

function orderedCandidates(messages, botUserId) {
    return [...messages]
        .filter(message => isUsableMessage(message, botUserId))
        .sort((a, b) => {
            const aPriority = (hasComponents(a) ? 4 : 0) + (isBuilderMarked(a) ? 2 : 0);
            const bPriority = (hasComponents(b) ? 4 : 0) + (isBuilderMarked(b) ? 2 : 0);
            if (aPriority !== bPriority) return bPriority - aPriority;
            return Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0);
        });
}

function recordName(embed) {
    const title = String(embed?.title || '').replace(/\s+/g, ' ').trim();
    if (title) return title.slice(0, 256);

    const firstLine = String(embed?.description || '')
        .split('\n')
        .map(line => line.replace(/^[>\s#*_`~|\-]+/, '').replace(/[*_`~]/g, '').trim())
        .find(Boolean);
    return String(firstLine || 'Untitled embed').slice(0, 256);
}

function recordsForMessage(guild, channel, message) {
    const records = [];
    for (let embedIndex = 0; embedIndex < (message.embeds?.length || 0); embedIndex += 1) {
        const embed = message.embeds[embedIndex];
        if (INTERNAL_TITLES.has(String(embed?.title || '').trim().toLowerCase())) continue;
        records.push({
            guildId: String(guild.id),
            channelId: String(channel.id),
            backingChannelId: null,
            messageId: String(message.id),
            embedIndex,
            source: 'embed-builder',
            title: String(embed?.title || '').slice(0, 256),
            name: recordName(embed),
            createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
        });
    }
    return records;
}

export async function discoverMissingChannelEmbeds(guild, channelId, botUserId) {
    if (!guild || !channelId || !botUserId) return [];

    const channel = guild.channels.cache.get(String(channelId))
        || await guild.channels.fetch(String(channelId)).catch(() => null);
    if (!channel?.messages?.fetch) return [];

    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const source = recent?.size ? recent.values() : channel.messages.cache.values();
    const messages = orderedCandidates(source, botUserId);
    if (!messages.length) return [];

    const records = [];
    for (const message of messages) {
        await registerCloudyEmbedMessage(message, 'embed-builder');
        records.push(...recordsForMessage(guild, channel, message));
    }
    return records;
}

export async function discoverMissingChannelEmbed(guild, channelId, botUserId) {
    const records = await discoverMissingChannelEmbeds(guild, channelId, botUserId);
    const record = records[0] || null;
    if (!record) return null;

    const channel = guild.channels.cache.get(String(channelId))
        || await guild.channels.fetch(String(channelId)).catch(() => null);
    if (!channel?.messages?.fetch) return null;

    const message = channel.messages.cache.get(record.messageId)
        || await channel.messages.fetch(record.messageId).catch(() => null);
    const embed = message?.embeds?.[Number(record.embedIndex || 0)] || null;
    if (!message || !embed) return null;

    return { channel, message, embed, record };
}
