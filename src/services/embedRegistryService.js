import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const REGISTRY_PREFIX = 'cloudy:embed-registry:';
const SCAN_BATCH_SIZE = 100;
const RECONCILE_CONCURRENCY = 6;
const DEFINITIVE_MISSING_CODES = new Set([10003, 10008, 50001, 50013]);
const registryMutationQueues = new Map();
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

function recordKey(record) {
    return `${String(record?.channelId || '')}:${String(record?.messageId || '')}:${Math.max(0, Number(record?.embedIndex) || 0)}`;
}

function messageKey(record) {
    return `${String(record?.channelId || '')}:${String(record?.messageId || '')}`;
}

function sortRecords(records) {
    return records.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function cleanStoredRecords(records) {
    const unique = new Map();

    for (const record of Array.isArray(records) ? records : []) {
        if (!record?.guildId || !record?.channelId || !record?.messageId || isInternalEmbedRecord(record)) continue;
        unique.set(recordKey(record), record);
    }

    return sortRecords([...unique.values()]);
}

async function mutateRegistry(guildId, operation) {
    const queueKey = String(guildId);
    const previous = registryMutationQueues.get(queueKey) || Promise.resolve();
    const current = previous
        .catch(() => {})
        .then(operation);

    registryMutationQueues.set(queueKey, current);
    try {
        return await current;
    } finally {
        if (registryMutationQueues.get(queueKey) === current) {
            registryMutationQueues.delete(queueKey);
        }
    }
}

async function readStoredRecords(guildId) {
    const stored = await getFromDb(registryKey(guildId), []);
    return Array.isArray(stored) ? stored : [];
}

async function mapWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;

    async function run() {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index], index);
        }
    }

    const workers = Array.from(
        { length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) },
        () => run(),
    );
    await Promise.all(workers);
    return results;
}

function cleanName(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function canonicalEmbedName(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (/^welcome to cloudy(?:\s+inc\.?)?$/i.test(text)) return 'Welcome to Cloudy Inc.';
    return text;
}

function cleanFieldName(value) {
    return String(value || '')
        .replace(/<a?:[^:>]+:\d+>/g, ' ')
        .replace(/[^a-z0-9&\s-]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function isCloudyWelcomeEmbed(embed) {
    const title = String(embed?.title || '').replace(/\s+/g, ' ').trim();
    if (/^welcome to cloudy(?:\s+inc\.?)?$/i.test(title)) return true;

    const fieldNames = new Set((embed?.fields || []).map(field => cleanFieldName(field?.name)));
    return fieldNames.has('rules')
        && fieldNames.has('link your account')
        && fieldNames.has('subscriptions & purchases')
        && fieldNames.has('support & help');
}

function isInternalEmbedRecord(record) {
    const title = cleanName(record?.title);
    const name = cleanName(record?.name);
    return INTERNAL_EMBED_NAMES.has(title)
        || INTERNAL_EMBED_NAMES.has(name)
        || title.includes('use the buttons below to create your message')
        || name.includes('use the buttons below to create your message');
}

export function isRegistrableCloudyEmbedMessage(message) {
    if (!message?.guildId || !message?.channelId || !message?.id || !message?.embeds?.length) return false;

    if (message.flags?.has?.(MessageFlags.Ephemeral)) return false;
    if (message.interaction || message.interactionMetadata) return false;

    return true;
}

function embedName(embed) {
    if (isCloudyWelcomeEmbed(embed)) return 'Welcome to Cloudy Inc.';

    const title = canonicalEmbedName(embed?.title || '');
    if (title) return title.slice(0, 256);

    const firstLine = String(embed?.description || '')
        .split('\n')
        .map(line => line.replace(/^[>\s#*_`~|\-]+/, '').replace(/[*_`~]/g, '').trim())
        .find(Boolean);

    return canonicalEmbedName(firstLine || 'Untitled embed').slice(0, 256);
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
        name: canonicalEmbedName(record.name || record.title || '').slice(0, 256),
        createdAt: record.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    return isInternalEmbedRecord(normalized) ? null : normalized;
}

export async function getEmbedRegistry(guildId) {
    const stored = await readStoredRecords(guildId);
    const cleaned = cleanStoredRecords(stored);
    if (cleaned.length !== stored.length) {
        await mutateRegistry(guildId, async () => {
            const latest = await readStoredRecords(guildId);
            const latestCleaned = cleanStoredRecords(latest);
            if (latestCleaned.length !== latest.length) {
                await setInDb(registryKey(guildId), latestCleaned);
            }
        });
    }
    return cleaned;
}

async function saveRecords(guildId, additions) {
    return mutateRegistry(guildId, async () => {
        const records = cleanStoredRecords(await readStoredRecords(guildId));
        const next = new Map(records.map(record => [recordKey(record), record]));

        for (const addition of additions) {
            const record = normalizeRecord(addition);
            if (!record) continue;
            const key = recordKey(record);
            next.set(key, { ...(next.get(key) || {}), ...record });
        }

        return setInDb(registryKey(guildId), sortRecords([...next.values()]));
    });
}

export async function registerCloudyEmbedMessage(message, source = 'cloudy') {
    if (!isRegistrableCloudyEmbedMessage(message)) return false;

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
    return mutateRegistry(guildId, async () => {
        const records = cleanStoredRecords(await readStoredRecords(guildId));
        const next = records.filter(item => !(
            String(item.channelId) === String(channelId) &&
            String(item.messageId) === String(messageId) &&
            Number(item.embedIndex || 0) === Number(embedIndex || 0)
        ));
        if (next.length === records.length) return false;
        return setInDb(registryKey(guildId), next);
    });
}

export async function removeEmbedRegistryMessage(guildId, channelId, messageId) {
    return mutateRegistry(guildId, async () => {
        const records = cleanStoredRecords(await readStoredRecords(guildId));
        const next = records.filter(item => !(
            String(item.channelId) === String(channelId) &&
            String(item.messageId) === String(messageId)
        ));
        if (next.length === records.length) return false;
        return setInDb(registryKey(guildId), next);
    });
}

export async function removeEmbedRegistryChannel(guildId, channelId) {
    return mutateRegistry(guildId, async () => {
        const records = cleanStoredRecords(await readStoredRecords(guildId));
        const next = records.filter(item => String(item.channelId) !== String(channelId));
        if (next.length === records.length) return false;
        return setInDb(registryKey(guildId), next);
    });
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

function recordsFromMessage(message, priorRecords = []) {
    if (!message?.guildId || !message?.channelId || !message?.id || !message?.embeds?.length) return [];
    const priorByIndex = new Map(priorRecords.map(record => [Number(record.embedIndex || 0), record]));

    return message.embeds
        .map((embed, embedIndex) => {
            const prior = priorByIndex.get(embedIndex);
            return normalizeRecord({
                guildId: message.guildId,
                channelId: message.channelId,
                messageId: message.id,
                embedIndex,
                source: prior?.source || 'reconciled',
                title: embed?.title || '',
                name: embedName(embed),
                createdAt: prior?.createdAt || message.createdAt?.toISOString?.() || new Date().toISOString(),
            });
        })
        .filter(Boolean);
}

async function resolveRegistryMessage(guild, records) {
    const first = records[0];
    let channel = guild.channels.cache.get(first.channelId) || null;

    if (!channel) {
        try {
            channel = await guild.channels.fetch(first.channelId);
        } catch (error) {
            return DEFINITIVE_MISSING_CODES.has(error?.code)
                ? { status: 'missing', records: [] }
                : { status: 'unknown', records };
        }
    }

    if (!channel?.messages?.fetch) return { status: 'missing', records: [] };

    let message;
    try {
        message = await channel.messages.fetch(first.messageId);
    } catch (error) {
        return DEFINITIVE_MISSING_CODES.has(error?.code)
            ? { status: 'missing', records: [] }
            : { status: 'unknown', records };
    }

    if (
        !message ||
        message.author?.id !== guild.client.user?.id ||
        !isRegistrableCloudyEmbedMessage(message)
    ) {
        return { status: 'missing', records: [] };
    }

    return { status: 'resolved', records: recordsFromMessage(message, records) };
}

export async function reconcileEmbedRegistry(guild) {
    if (!guild?.id || !guild.client?.user?.id) {
        return { records: [], checkedMessages: 0, removedRecords: 0 };
    }

    const snapshot = await getEmbedRegistry(guild.id);
    if (!snapshot.length) {
        return { records: [], checkedMessages: 0, removedRecords: 0 };
    }

    const groups = new Map();
    for (const record of snapshot) {
        const key = messageKey(record);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
    }

    const entries = [...groups.entries()];
    const resolved = await mapWithConcurrency(entries, RECONCILE_CONCURRENCY, async ([key, records]) => [
        key,
        await resolveRegistryMessage(guild, records),
    ]);
    const results = new Map(resolved);

    const records = await mutateRegistry(guild.id, async () => {
        const latest = cleanStoredRecords(await readStoredRecords(guild.id));
        const next = [];
        const replacedMessages = new Set(results.keys());

        for (const record of latest) {
            if (!replacedMessages.has(messageKey(record))) next.push(record);
        }

        for (const [key, result] of results) {
            if (result.status === 'resolved') next.push(...result.records);
            if (result.status === 'unknown') {
                next.push(...latest.filter(record => messageKey(record) === key));
            }
        }

        const cleaned = cleanStoredRecords(next);
        await setInDb(registryKey(guild.id), cleaned);
        return cleaned;
    });

    return {
        records,
        checkedMessages: entries.length,
        removedRecords: Math.max(0, snapshot.length - records.filter(record => results.has(messageKey(record))).length),
    };
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
                if (message.author?.id !== botUserId || !isRegistrableCloudyEmbedMessage(message)) continue;

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
