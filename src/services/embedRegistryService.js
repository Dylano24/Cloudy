import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const REGISTRY_PREFIX = 'cloudy:embed-registry:';
const SCAN_BATCH_SIZE = 100;
const INTERNAL_EMBED_NAMES = new Set([
    'message builder',
    'modify embed',
    'embed loaded',
    'changes saved',
    'could not load embeds',
    'configuration error',
    '(use the buttons below to create your message)',
    'use the buttons below to create your message',
    'untitled embed',
]);

function registryKey(guildId) {
    return `${REGISTRY_PREFIX}${guildId}`;
}

function cleanName(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isInternalEmbedRecord(record) {
    const title = cleanName(record?.title);
    const name = cleanName(record?.name);
    return INTERNAL_EMBED_NAMES.has(title)
        || INTERNAL_EMBED_NAMES.has(name)
        || title.includes('use the buttons below to create your message')
        || name.includes('use the buttons below to create your message');
}

function embedName(embed) {
    const title = String(embed?.title || '').replace(/\s+/g, ' ').trim();
    if (title) return title.slice(0, 256);

    const firstLine = String(embed?.description || '')
        .split('\n')
        .map(line => line.replace(/^[>\s#*_`~|\-]+/, '').replace(/[*_`~]/g, '').trim())
        .find(Boolean);

    return (firstLine || 'Untitled embed').slice(0, 256);
}

function normalizeRecord(record) {
    if (!record?.guildId || !record?.channelId || !record?.messageId) return null;
    const normalized = {
        guildId: String(record.guildId),
        channelId: String(record.channelId),
        messageId: String(record.messageId),
        embedIndex: Math.max(0, Number(record.embedIndex) || 0),
        source: String(record.source || 'cloudy'),
        title: String(record.title || '').slice(0, 256),
        name: String(record.name || record.title || '').slice(0, 256),
        createdAt: record.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    return isInternalEmbedRecord(normalized) ? null : normalized;
}

export async function getEmbedRegistry(guildId) {
    const stored = await getFromDb(registryKey(guildId), []);
    if (!Array.isArray(stored)) return [];

    const cleaned = stored.filter(record => !isInternalEmbedRecord(record));
    if (cleaned.length !== stored.length) {
        await setInDb(registryKey(guildId), cleaned);
    }
    return cleaned;
}

async function saveRecords(guildId, additions) {
    const records = await getEmbedRegistry(guildId);
    const next = [...records];

    for (const addition of additions) {
        const record = normalizeRecord(addition);
        if (!record) continue;
        const existingIndex = next.findIndex(item =>
            String(item.channelId) === record.channelId &&
            String(item.messageId) === record.messageId &&
            Number(item.embedIndex || 0) === record.embedIndex,
        );

        if (existingIndex >= 0) next[existingIndex] = { ...next[existingIndex], ...record };
        else next.push(record);
    }

    next.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    await setInDb(registryKey(guildId), next);
    return true;
}

export async function registerCloudyEmbedMessage(message, source = 'cloudy') {
    if (!message?.guildId || !message?.channelId || !message?.id || !message?.embeds?.length) return false;

    try {
        const additions = message.embeds
            .map((embed, embedIndex) => ({
                guildId: message.guildId,
                channelId: message.channelId,
                messageId: message.id,
                embedIndex,
                source,
                title: embed?.title || '',
                name: embedName(embed),
                createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
            }))
            .filter(addition => !isInternalEmbedRecord(addition));

        if (!additions.length) return false;
        return await saveRecords(message.guildId, additions);
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

export async function scanGuildForCloudyEmbeds(guild, botUserId, { maxMessagesPerChannel = Infinity } = {}) {
    if (!guild || !botUserId) return { scanned: 0, found: 0 };

    let scanned = 0;
    let found = 0;
    const additions = [];

    for (const channel of readableTextChannels(guild)) {
        let before;
        let channelScanned = 0;

        while (channelScanned < maxMessagesPerChannel) {
            const remaining = maxMessagesPerChannel - channelScanned;
            const limit = Number.isFinite(remaining) ? Math.min(SCAN_BATCH_SIZE, remaining) : SCAN_BATCH_SIZE;
            const batch = await channel.messages.fetch({ limit, before }).catch(() => null);
            if (!batch?.size) break;

            for (const message of batch.values()) {
                scanned += 1;
                channelScanned += 1;
                if (message.author?.id !== botUserId || !message.embeds?.length) continue;

                for (let embedIndex = 0; embedIndex < message.embeds.length; embedIndex += 1) {
                    const embed = message.embeds[embedIndex];
                    const addition = {
                        guildId: guild.id,
                        channelId: channel.id,
                        messageId: message.id,
                        embedIndex,
                        source: 'history',
                        title: embed?.title || '',
                        name: embedName(embed),
                        createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
                    };
                    if (isInternalEmbedRecord(addition)) continue;
                    additions.push(addition);
                    found += 1;
                }
            }

            const oldest = batch.last();
            if (!oldest || batch.size < limit) break;
            before = oldest.id;
        }
    }

    if (additions.length) await saveRecords(guild.id, additions);
    return { scanned, found };
}
