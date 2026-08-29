import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const REGISTRY_PREFIX = 'cloudy:embed-registry:';
const MAX_RECORDS_PER_GUILD = 5000;
const SCAN_BATCH_SIZE = 100;

function registryKey(guildId) {
    return `${REGISTRY_PREFIX}${guildId}`;
}

function normalizeRecord(record) {
    if (!record?.guildId || !record?.channelId || !record?.messageId) return null;
    return {
        guildId: String(record.guildId),
        channelId: String(record.channelId),
        messageId: String(record.messageId),
        embedIndex: Math.max(0, Number(record.embedIndex) || 0),
        source: String(record.source || 'cloudy'),
        createdAt: record.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

export async function getEmbedRegistry(guildId) {
    const stored = await getFromDb(registryKey(guildId), []);
    return Array.isArray(stored) ? stored : [];
}

export async function registerCloudyEmbedMessage(message, source = 'cloudy') {
    if (!message?.guildId || !message?.channelId || !message?.id || !message?.embeds?.length) return false;

    try {
        const records = await getEmbedRegistry(message.guildId);
        const next = [...records];

        for (let embedIndex = 0; embedIndex < message.embeds.length; embedIndex += 1) {
            const record = normalizeRecord({
                guildId: message.guildId,
                channelId: message.channelId,
                messageId: message.id,
                embedIndex,
                source,
                createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
            });
            if (!record) continue;

            const existingIndex = next.findIndex(item =>
                String(item.channelId) === record.channelId &&
                String(item.messageId) === record.messageId &&
                Number(item.embedIndex || 0) === record.embedIndex,
            );

            if (existingIndex >= 0) {
                next[existingIndex] = { ...next[existingIndex], ...record };
            } else {
                next.push(record);
            }
        }

        next.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        if (next.length > MAX_RECORDS_PER_GUILD) next.length = MAX_RECORDS_PER_GUILD;
        await setInDb(registryKey(message.guildId), next);
        return true;
    } catch (error) {
        logger.error('Failed to register Cloudy embed message:', error);
        return false;
    }
}

export async function removeEmbedRegistryRecord(guildId, channelId, messageId, embedIndex = 0) {
    const records = await getEmbedRegistry(guildId);
    const next = records.filter(item => !(
        String(item.channelId) === String(channelId) &&
        String(item.messageId) === String(messageId) &&
        Number(item.embedIndex || 0) === Number(embedIndex || 0)
    ));
    if (next.length !== records.length) await setInDb(registryKey(guildId), next);
}

export async function resolveEmbedRegistryRecord(guild, record) {
    if (!guild || !record) return null;
    const channel = guild.channels.cache.get(record.channelId)
        || await guild.channels.fetch(record.channelId).catch(() => null);
    if (!channel?.messages?.fetch) return null;

    const message = await channel.messages.fetch(record.messageId).catch(() => null);
    if (!message) {
        await removeEmbedRegistryRecord(guild.id, record.channelId, record.messageId, record.embedIndex);
        return null;
    }

    const embed = message.embeds?.[Number(record.embedIndex || 0)] || null;
    if (!embed) {
        await removeEmbedRegistryRecord(guild.id, record.channelId, record.messageId, record.embedIndex);
        return null;
    }

    return { channel, message, embed, record };
}

function readableTextChannels(guild) {
    const me = guild.members.me;
    return [...guild.channels.cache.values()]
        .filter(channel =>
            (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) &&
            channel.messages?.fetch &&
            channel.permissionsFor(me)?.has([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
            ]),
        )
        .sort((a, b) => a.position - b.position || String(a.name).localeCompare(String(b.name)));
}

export async function scanGuildForCloudyEmbeds(guild, botUserId, { maxMessagesPerChannel = 2500 } = {}) {
    if (!guild || !botUserId) return { scanned: 0, found: 0 };

    let scanned = 0;
    let found = 0;

    for (const channel of readableTextChannels(guild)) {
        let before;
        let channelScanned = 0;

        while (channelScanned < maxMessagesPerChannel) {
            const limit = Math.min(SCAN_BATCH_SIZE, maxMessagesPerChannel - channelScanned);
            const batch = await channel.messages.fetch({ limit, before }).catch(() => null);
            if (!batch?.size) break;

            for (const message of batch.values()) {
                scanned += 1;
                channelScanned += 1;
                if (message.author?.id !== botUserId || !message.embeds?.length) continue;
                if (await registerCloudyEmbedMessage(message, 'history')) found += message.embeds.length;
            }

            const oldest = batch.last();
            if (!oldest || batch.size < limit) break;
            before = oldest.id;
        }
    }

    return { scanned, found };
}
