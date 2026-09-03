import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const REGISTRY_PREFIX = 'cloudy:embed-registry:';
const SCAN_BATCH_SIZE = 100;
const RECONCILE_CONCURRENCY = 6;
const DEFINITIVE_MISSING_CODES = new Set([10003, 10008, 50001, 50013]);
const SYSTEM_CATALOG_CONTENT = 'System & error embed templates';
const SYSTEM_TEMPLATE_KEY_PREFIX = 'Cloudy template key:';
const SYSTEM_TEMPLATE_CONTEXT_SEPARATOR = ' || Cloudy context:';
const SYSTEM_TEMPLATE_KIND_SEPARATOR = ' || Cloudy kind:';
const registryMutationQueues = new Map();
const embedSnapshotCache = new Map();
const EMBED_SNAPSHOT_CACHE_LIMIT = 2000;
const INTERNAL_EMBED_NAMES = new Set([
    'message builder',
    'modify embed',
    'embed loaded',
    'changes saved',
    'could not load embeds',
    '(use the buttons below to create your message)',
    'use the buttons below to create your message',
    'untitled embed',
]);

const SYSTEM_TEMPLATE_PLACEMENTS = [
    {
        match: /\b(gambl|gambling|bet|wallet|cash|money|fight|flip|roll|dice|cooldown|wrong channel|not enough money)\b/i,
        channelSlugs: ['gambling'],
    },
    {
        match: /\b(ticket|transcript|claim ticket|close ticket|reopen ticket)\b/i,
        channelSlugs: ['ticket-logs', 'ticket-panel', 'tickets'],
    },
    {
        match: /\b(appeal|ban appeal)\b/i,
        channelSlugs: ['ban-appeal', 'appeal'],
    },
    {
        match: /\b(report|reported)\b/i,
        channelSlugs: ['reports', 'report'],
    },
    {
        match: /\b(shop|purchase|subscription)\b/i,
        channelSlugs: ['shop', 'purchases'],
    },
    {
        match: /\b(music|song|track|queue)\b/i,
        channelSlugs: ['music'],
    },
];

function registryKey(guildId) {
    return `${REGISTRY_PREFIX}${guildId}`;
}

function physicalChannelId(record) {
    return String(record?.backingChannelId || record?.channelId || '');
}

function recordKey(record) {
    return `${physicalChannelId(record)}:${String(record?.messageId || '')}:${Math.max(0, Number(record?.embedIndex) || 0)}`;
}

function messageKey(record) {
    return `${physicalChannelId(record)}:${String(record?.messageId || '')}`;
}

function rememberEmbedSnapshot(record, embed) {
    if (!record?.channelId || !record?.messageId || !embed) return;
    const key = recordKey(record);
    const data = typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
    if (!data || typeof data !== 'object') return;

    embedSnapshotCache.delete(key);
    embedSnapshotCache.set(key, data);
    while (embedSnapshotCache.size > EMBED_SNAPSHOT_CACHE_LIMIT) {
        const oldest = embedSnapshotCache.keys().next().value;
        if (!oldest) break;
        embedSnapshotCache.delete(oldest);
    }
}

export function getEmbedRegistrySnapshot(record) {
    if (!record) return null;
    return embedSnapshotCache.get(recordKey(record)) || null;
}

function sortRecords(records) {
    return records.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function cleanStoredRecords(records) {
    const unique = new Map();

    for (const record of Array.isArray(records) ? records : []) {
        if (!record?.guildId || !record?.channelId || !record?.messageId || isInternalEmbedRecord(record) || !isFixedCloudyRecord(record)) continue;
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

function embedFieldNames(embed) {
    return new Set((embed?.fields || []).map(field => cleanFieldName(field?.name)));
}

function isCloudyWelcomeEmbed(embed) {
    const title = String(embed?.title || '').replace(/\s+/g, ' ').trim();
    if (/^welcome to cloudy(?:\s+inc\.?)?$/i.test(title)) return true;

    const fieldNames = embedFieldNames(embed);
    return fieldNames.has('rules')
        && fieldNames.has('link your account')
        && fieldNames.has('subscriptions & purchases')
        && fieldNames.has('support & help');
}

function isInviteCreatedEmbed(embed) {
    const fieldNames = embedFieldNames(embed);
    return fieldNames.has('created by')
        && fieldNames.has('invite')
        && fieldNames.has('channel')
        && fieldNames.has('maximum uses')
        && fieldNames.has('expires')
        && fieldNames.has('created');
}

function isInviteJoinEmbed(embed) {
    const fieldNames = embedFieldNames(embed);
    return fieldNames.has('member')
        && fieldNames.has('invited by')
        && fieldNames.has('invite')
        && fieldNames.has('invite uses')
        && fieldNames.has('account age')
        && fieldNames.has('joined server');
}

function isInternalEmbedRecord(record) {
    const title = cleanName(record?.title);
    const name = cleanName(record?.name);
    return INTERNAL_EMBED_NAMES.has(title)
        || INTERNAL_EMBED_NAMES.has(name)
        || title.includes('use the buttons below to create your message')
        || name.includes('use the buttons below to create your message');
}

function isFixedCloudyEmbed(embed) {
    if (isCloudyWelcomeEmbed(embed) || isInviteCreatedEmbed(embed) || isInviteJoinEmbed(embed)) return true;
    const title = cleanName(embed?.title);
    return /^(?:kick|ban|unban|timeout|untimeout|report)\s+log\b/.test(title)
        || /^(?:invite created|member joined using invite)$/.test(title);
}

function isFixedCloudyRecord(record) {
    if (['system-catalog', 'embed-builder'].includes(String(record?.source || ''))) return true;
    const names = [record?.title, record?.name].map(cleanName).filter(Boolean);
    return names.some(title =>
        /^(?:welcome to cloudy(?: inc\.?)?|kick|ban|unban|timeout|untimeout|report)\b/.test(title)
        || /^(?:invite created|member joined using invite)$/.test(title),
    );
}

function isManualBuilderRecord(record) {
    return String(record?.source || '') === 'embed-builder';
}

export function isRegistrableCloudyEmbedMessage(message) {
    if (!message?.guildId || !message?.channelId || !message?.id || !message?.embeds?.length) return false;

    if (message.flags?.has?.(MessageFlags.Ephemeral)) return false;
    if (message.interaction || message.interactionMetadata) return false;

    return isSystemCatalogMessage(message) || message.embeds.some(isFixedCloudyEmbed);
}

function embedName(embed) {
    if (isCloudyWelcomeEmbed(embed)) return 'Welcome to Cloudy Inc.';
    if (isInviteCreatedEmbed(embed)) return 'Invite created';
    if (isInviteJoinEmbed(embed)) return 'Member joined using invite';

    const title = canonicalEmbedName(embed?.title || '');
    if (title) return title.slice(0, 256);

    const firstLine = String(embed?.description || '')
        .split('\n')
        .map(line => line.replace(/^[>\s#*_`~|\-]+/, '').replace(/[*_`~]/g, '').trim())
        .find(Boolean);

    return canonicalEmbedName(firstLine || 'Untitled embed').slice(0, 256);
}

function isSystemCatalogMessage(message) {
    return String(message?.content || '').trim() === SYSTEM_CATALOG_CONTENT;
}

function systemTemplateSearchText(embed) {
    const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : (embed || {});
    const authorName = String(data.author?.name || '');
    const stableKey = authorName.toLowerCase().startsWith(SYSTEM_TEMPLATE_KEY_PREFIX.toLowerCase())
        ? authorName.slice(SYSTEM_TEMPLATE_KEY_PREFIX.length)
        : '';
    return [stableKey, systemTemplateContext(embed), data.title, data.description]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function systemTemplateContext(embed) {
    const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : (embed || {});
    const authorName = String(data.author?.name || '');
    if (!authorName.toLowerCase().startsWith(SYSTEM_TEMPLATE_KEY_PREFIX.toLowerCase())) return '';

    let metadata = authorName.slice(SYSTEM_TEMPLATE_KEY_PREFIX.length).trim();
    const kindIndex = metadata.toLowerCase().indexOf(SYSTEM_TEMPLATE_KIND_SEPARATOR.toLowerCase());
    if (kindIndex !== -1) metadata = metadata.slice(0, kindIndex);

    const contextIndex = metadata.toLowerCase().indexOf(SYSTEM_TEMPLATE_CONTEXT_SEPARATOR.toLowerCase());
    if (contextIndex === -1) return '';
    return cleanName(metadata.slice(contextIndex + SYSTEM_TEMPLATE_CONTEXT_SEPARATOR.length));
}

function placementSlugsForTemplateContext(context) {
    const root = cleanName(context).split('/')[0];
    const placements = {
        gambling: ['gambling'],
        tickets: ['ticket-logs', 'ticket-panel', 'tickets'],
        'ban-appeal': ['ban-appeal', 'appeal'],
        reports: ['reports', 'report'],
        shop: ['shop', 'purchases'],
        music: ['music'],
        welcome: ['welcome'],
        faq: ['faq'],
        rules: ['rules'],
        'staff-reviews': ['staff-reviews'],
        botlog: ['botlog'],
    };
    return placements[root] || [];
}

function findFeatureChannel(guild, slugs = []) {
    const normalizedSlugs = slugs.map(slug => cleanName(slug)).filter(Boolean);
    if (!normalizedSlugs.length) return null;

    const candidates = [...(guild?.channels?.cache?.values?.() || [])]
        .filter(channel => channel?.isTextBased?.() && channel?.messages?.fetch)
        .map(channel => {
            const channelName = cleanName(channel.name);
            const parentName = cleanName(channel.parent?.name);
            let score = 0;

            for (const slug of normalizedSlugs) {
                if (channelName === slug) score = Math.max(score, 100);
                else if (channelName.includes(slug)) score = Math.max(score, 80);
                else if (parentName === slug) score = Math.max(score, 60);
                else if (parentName.includes(slug)) score = Math.max(score, 40);
            }

            return { channel, score };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.channel.position - b.channel.position);

    return candidates[0]?.channel || null;
}

function catalogDisplayChannelId(message, embed) {
    if (!isSystemCatalogMessage(message)) return String(message.channelId);

    // A saved custom title can remove every keyword from the visible embed.
    // Its stable catalog context still identifies the real destination scope.
    const contextualChannel = findFeatureChannel(
        message.guild,
        placementSlugsForTemplateContext(systemTemplateContext(embed)),
    );
    if (contextualChannel?.id) return String(contextualChannel.id);

    const text = systemTemplateSearchText(embed);
    for (const placement of SYSTEM_TEMPLATE_PLACEMENTS) {
        if (!placement.match.test(text)) continue;
        const channel = findFeatureChannel(message.guild, placement.channelSlugs);
        if (channel?.id) return String(channel.id);
    }

    return String(message.channelId);
}

function recordLocationForEmbed(message, embed, prior = null) {
    const displayChannelId = catalogDisplayChannelId(message, embed);
    const actualChannelId = String(message.channelId);
    const isVirtualPlacement = displayChannelId !== actualChannelId;

    return {
        channelId: displayChannelId,
        backingChannelId: isVirtualPlacement
            ? actualChannelId
            : (prior?.backingChannelId ? String(prior.backingChannelId) : null),
    };
}

function normalizeRecord(record) {
    if (!record?.guildId || !record?.channelId || !record?.messageId) return null;
    const normalized = {
        guildId: String(record.guildId),
        channelId: String(record.channelId),
        backingChannelId: record.backingChannelId ? String(record.backingChannelId) : null,
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

export async function registerCloudyEmbedMessages(messages, source = 'cloudy') {
    const grouped = new Map();
    // A message deliberately sent from the Embed Builder is a user-created
    // template and must remain editable even when its title is custom. Normal
    // bot traffic stays restricted to the fixed template types below.
    const isManualBuilderMessage = source === 'embed-builder';

    try {
        for (const message of Array.isArray(messages) ? messages : []) {
            if (!isManualBuilderMessage && !isRegistrableCloudyEmbedMessage(message)) continue;

            const additions = message.embeds
                .map((embed, embedIndex) => {
                    const location = recordLocationForEmbed(message, embed);
                    const addition = {
                        guildId: message.guildId,
                        ...location,
                        messageId: message.id,
                        embedIndex,
                        source: isSystemCatalogMessage(message) ? 'system-catalog' : source,
                        title: embed?.title || '',
                        name: embedName(embed),
                        createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
                    };
                    rememberEmbedSnapshot(addition, embed);
                    return addition;
                })
                .filter(addition => isSystemCatalogMessage(message)
                    || isManualBuilderMessage
                    || (!isInternalEmbedRecord(addition) && isFixedCloudyEmbed(message.embeds[addition.embedIndex])));

            if (!additions.length) continue;
            if (!grouped.has(message.guildId)) grouped.set(message.guildId, []);
            grouped.get(message.guildId).push(...additions);
        }

        if (!grouped.size) return false;
        await Promise.all([...grouped.entries()].map(([guildId, additions]) => saveRecords(guildId, additions)));
        return true;
    } catch (error) {
        logger.error('Failed to register Cloudy embed messages:', error);
        return false;
    }
}

export async function registerCloudyEmbedMessage(message, source = 'cloudy') {
    return registerCloudyEmbedMessages([message], source);
}

export async function removeEmbedRegistryRecord(guildId, channelId, messageId, embedIndex = 0) {
    return mutateRegistry(guildId, async () => {
        const records = cleanStoredRecords(await readStoredRecords(guildId));
        const next = records.filter(item => !(
            (String(item.channelId) === String(channelId) || physicalChannelId(item) === String(channelId)) &&
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
            (String(item.channelId) === String(channelId) || physicalChannelId(item) === String(channelId)) &&
            String(item.messageId) === String(messageId)
        ));
        if (next.length === records.length) return false;
        return setInDb(registryKey(guildId), next);
    });
}

export async function removeEmbedRegistryChannel(guildId, channelId) {
    return mutateRegistry(guildId, async () => {
        const records = cleanStoredRecords(await readStoredRecords(guildId));
        const next = records.filter(item =>
            String(item.channelId) !== String(channelId) && physicalChannelId(item) !== String(channelId),
        );
        if (next.length === records.length) return false;
        return setInDb(registryKey(guildId), next);
    });
}

export async function resolveEmbedRegistryRecord(guild, record) {
    if (!guild || !record) return null;
    const sourceChannelId = physicalChannelId(record);
    const channel = guild.channels.cache.get(sourceChannelId)
        || await guild.channels.fetch(sourceChannelId).catch(() => null);
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

    rememberEmbedSnapshot(record, embed);
    return { channel, message, embed, record };
}

function recordsFromMessage(message, priorRecords = [], { allowManual = false } = {}) {
    if (!message?.guildId || !message?.channelId || !message?.id || !message?.embeds?.length) return [];
    const priorByIndex = new Map(priorRecords.map(record => [Number(record.embedIndex || 0), record]));

    return message.embeds
        .map((embed, embedIndex) => {
            const prior = priorByIndex.get(embedIndex);
            const location = recordLocationForEmbed(message, embed, prior);
            const record = normalizeRecord({
                guildId: message.guildId,
                ...location,
                messageId: message.id,
                embedIndex,
                source: isSystemCatalogMessage(message) ? 'system-catalog' : (prior?.source || 'reconciled'),
                title: embed?.title || '',
                name: embedName(embed),
                createdAt: prior?.createdAt || message.createdAt?.toISOString?.() || new Date().toISOString(),
            });
            if (!record || (!allowManual && !isSystemCatalogMessage(message) && !isFixedCloudyEmbed(embed))) return null;
            rememberEmbedSnapshot(record, embed);
            return record;
        })
        .filter(Boolean);
}

async function resolveRegistryMessage(guild, records) {
    const first = records[0];
    const sourceChannelId = physicalChannelId(first);
    let channel = guild.channels.cache.get(sourceChannelId) || null;

    if (!channel) {
        try {
            channel = await guild.channels.fetch(sourceChannelId);
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
        (!isRegistrableCloudyEmbedMessage(message) && !records.some(isManualBuilderRecord))
    ) {
        return { status: 'missing', records: [] };
    }

    return {
        status: 'resolved',
        records: recordsFromMessage(message, records, {
            allowManual: records.some(isManualBuilderRecord),
        }),
    };
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
                    if (!isSystemCatalogMessage(message) && !isFixedCloudyEmbed(embed)) continue;
                    const location = recordLocationForEmbed(message, embed);
                    const addition = {
                        guildId: guild.id,
                        ...location,
                        messageId: message.id,
                        embedIndex,
                        source: isSystemCatalogMessage(message) ? 'system-catalog' : 'history',
                        title: embed?.title || '',
                        name: embedName(embed),
                        createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
                    };
                    if (isInternalEmbedRecord(addition)) continue;
                    rememberEmbedSnapshot(addition, embed);
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
