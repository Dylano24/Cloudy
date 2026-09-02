import { MessageFlags } from 'discord.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from './cloudyBrandingService.js';
import { registerCloudyEmbedMessage } from './embedRegistryService.js';

const DISCOVERY_LIMIT = 100;
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

    return message.embeds.some(embed => {
        const title = String(embed?.title || '').trim().toLowerCase();
        return !INTERNAL_TITLES.has(title);
    });
}

function isBuilderMarked(message) {
    return message.embeds?.some(embed =>
        String(embed?.footer?.text || '').endsWith(MESSAGE_BUILDER_FOOTER_MARKER),
    );
}

function hasComponents(message) {
    return Array.isArray(message?.components) && message.components.length > 0;
}

function candidatePriority(message) {
    if (hasComponents(message) && isBuilderMarked(message)) return 3;
    if (hasComponents(message)) return 2;
    if (isBuilderMarked(message)) return 1;
    return 0;
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

function buildRecords(guild, channel, message) {
    return message.embeds
        .map((embed, embedIndex) => {
            const title = String(embed?.title || '').trim().toLowerCase();
            if (INTERNAL_TITLES.has(title)) return null;

            return {
                guildId: String(guild.id),
                channelId: String(channel.id),
                backingChannelId: null,
                messageId: String(message.id),
                embedIndex,
                source: 'embed-builder',
                title: String(embed?.title || '').slice(0, 256),
                name: recordName(embed),
                createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
                discoveryPriority: candidatePriority(message),
            };
        })
        .filter(Boolean);
}

async function getRecentUsableMessages(channel, botUserId) {
    const cached = [...channel.messages.cache.values()]
        .filter(message => isUsableMessage(message, botUserId));

    const fetched = await channel.messages.fetch({ limit: DISCOVERY_LIMIT }).catch(() => null);
    const merged = new Map(cached.map(message => [String(message.id), message]));
    for (const message of fetched?.values?.() || []) {
        if (isUsableMessage(message, botUserId)) merged.set(String(message.id), message);
    }

    return [...merged.values()].sort((a, b) =>
        candidatePriority(b) - candidatePriority(a)
        || Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0),
    );
}

export async function discoverMissingChannelEmbeds(guild, channelId, botUserId) {
    if (!guild || !channelId || !botUserId) return [];

    const channel = guild.channels.cache.get(String(channelId))
        || await guild.channels.fetch(String(channelId)).catch(() => null);
    if (!channel?.messages?.fetch) return [];

    const messages = await getRecentUsableMessages(channel, botUserId);
    if (!messages.length) return [];

    // Registration primes the in-memory embed snapshots used by the Builder.
    // Keep this sequential so registry writes cannot race each other.
    const records = [];
    for (const message of messages) {
        await registerCloudyEmbedMessage(message, 'embed-builder');
        records.push(...buildRecords(guild, channel, message));
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

    const message = channel.messages.cache.get(String(record.messageId))
        || await channel.messages.fetch(String(record.messageId)).catch(() => null);
    const embed = message?.embeds?.[Number(record.embedIndex || 0)] || null;
    if (!message || !embed) return null;

    return { channel, message, embed, record };
}
