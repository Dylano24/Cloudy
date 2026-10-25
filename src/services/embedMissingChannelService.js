import { MessageFlags } from 'discord.js';
import { isBuilderSessionMessage } from '../utils/builderSessionCleanup.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from './cloudyBrandingService.js';
import { isTransientStatusEmbed } from '../utils/transientResponse.js';
import { getGuildConfig, peekGuildConfigCache } from './config/guildConfig.js';
import {
    getTicketLogTemplate,
    isTicketLogTemplateChannel,
} from '../utils/ticket/ticketLogTemplates.js';

const DISCOVERY_PAGE_SIZE = 100;
const INTERNAL_TITLES = new Set([
    'message builder',
    'modify embed',
    'embed loaded',
    'changes saved',
    'could not load embeds',
]);
const discoveryCache = new Map();
// Read-only latest verified Discord rows. Never persist these as manual Saves.
// Opening the Builder or changing channel can reuse a warm snapshot immediately.
const recentChannelIndex = new Map();
const RECENT_INDEX_TTL_MS = 10 * 60_000;

// Remove all ghost references when a confirmed Delete physically removes a
// Cloudy post. A warm read-only scan cannot resurrect it in channel lists.
export function invalidateIndexedRecentChannelEmbeds(guildId, channelId, messageId) {
    const key = String(guildId) + ':' + String(channelId);
    const indexed = recentChannelIndex.get(key);
    if (indexed) indexed.records = indexed.records.filter(record =>
        String(record.messageId) !== String(messageId));
    discoveryCache.get(String(channelId))?.messages?.delete?.(String(messageId));
}

export function peekIndexedRecentChannelEmbeds(guild) {
    const guildId = String(guild?.id || '');
    if (!guildId) return [];
    const now = Date.now();
    const records = [];
    for (const [key, value] of recentChannelIndex) {
        if (now - value.timestamp >= RECENT_INDEX_TTL_MS) {
            recentChannelIndex.delete(key);
            continue;
        }
        if (key.startsWith(guildId + ':')) records.push(...value.records);
    }
    return records;
}

export function isUsableMessage(message, botUserId) {
    if (!message?.guildId || message.author?.id !== botUserId || !message.embeds?.length) return false;
    if (message.flags?.has?.(MessageFlags.Ephemeral)) return false;
    // Reject the entire panel, including its real-looking preview embed.
    if (isBuilderSessionMessage(message)) return false;
    // Command invocations generate live Discord responses, not independent
    // Builder saves. Their reusable definitions remain in the source catalog.
    // Deliberately posted Builder messages do not have an interaction origin.
    if (message.interaction || message.interactionMetadata) return false;
    if (message.reference?.messageId && !isBuilderMarked(message)) return false;
    // This is discovery of PHYSICALLY POSTED Discord messages, not a Save.
    // Older Cloudy panels and game/log outputs often predate the Builder footer
    // marker; hiding them made the channel browser appear empty. Still exclude
    // ephemeral / command replies and purely transient status notifications.
    return message.embeds.some(embed => {
        const title = String(embed?.title || '').trim().toLowerCase();
        return !INTERNAL_TITLES.has(title)
            && (isBuilderMarked(message) || !isTransientStatusEmbed(embed));
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

function embedSnapshot(embed) {
    if (!embed) return null;
    const data = typeof embed.toJSON === 'function' ? embed.toJSON() : { ...embed };
    return data && typeof data === 'object' ? data : null;
}

function buildRecords(guild, channel, message, guildConfig = null) {
    return message.embeds
        .map((embed, embedIndex) => {
            const title = String(embed?.title || '').trim().toLowerCase();
            if (INTERNAL_TITLES.has(title)) return null;

            const isTicketLogResponse = Boolean(getTicketLogTemplate(embed));
            const isReusableTicketLog = isTicketLogTemplateChannel(guildConfig, channel.id)
                && isTicketLogResponse;
            // A ticket lifecycle reply outside configured ticket log channels is
            // not a saved panel, even if its snapshot has the same log fields.
            if (isTicketLogResponse && !isReusableTicketLog && !isBuilderMarked(message)) return null;
            // A real, persistent bot embed is browseable without a modern
            // footer marker. This snapshot stays session-only until Save.
            if (!isBuilderMarked(message) && !isReusableTicketLog
                && isTransientStatusEmbed(embed)) return null;

            return {
                guildId: String(guild.id),
                channelId: String(channel.id),
                backingChannelId: null,
                messageId: String(message.id),
                embedIndex,
                // Only structurally verified logs in the configured ticket log
                // destinations are reusable. All other discovery records stay
                // session-only/direct editable embeds.
                source: isReusableTicketLog ? 'ticket-log' : 'embed-builder',
                title: String(embed?.title || '').slice(0, 256),
                name: recordName(embed),
                createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
                discoveryPriority: candidatePriority(message),
                snapshot: embedSnapshot(embed),
            };
        })
        .filter(Boolean);
}

// Synchronous, read-only view of already cached physical Cloudy posts.
// New channels are included automatically via guild.channels.cache. Never
// block the initial channel menu on REST or PostgreSQL.
export function peekCachedPhysicalChannelEmbeds(guild, botUserId) {
    if (!guild?.id || !botUserId) return [];
    const guildConfig = peekGuildConfigCache(guild.id);
    const rows = [];
    for (const channel of guild.channels?.cache?.values?.() || []) {
        if (![0, 5].includes(channel?.type) || !channel?.messages?.cache) continue;
        for (const message of channel.messages.cache.values()) {
            if (isUsableMessage(message, botUserId)) {
                rows.push(...buildRecords(guild, channel, message, guildConfig));
            }
        }
    }
    return rows;
}

function mergeUsableMessages(target, messages, botUserId) {
    for (const message of messages || []) {
        if (isUsableMessage(message, botUserId)) target.set(String(message.id), message);
    }
}

function sortedMessages(state) {
    return [...state.messages.values()].sort((a, b) =>
        candidatePriority(b) - candidatePriority(a)
        || Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0),
    );
}

async function getRecentUsableMessages(channel, botUserId, { fullHistory = true, onBatch = null, shouldContinue = null } = {}) {
    const cacheKey = String(channel.id);
    const existing = discoveryCache.get(cacheKey);
    const reuseNewest = fullHistory && existing?.newestCheckedAt
        && Date.now() - existing.newestCheckedAt < 5_000;
    // Every new quick channel selection makes Discord the authority. Historical
    // cached snapshots from a previous session cannot masquerade as live posts.
    const newestBatch = reuseNewest ? null
        : await channel.messages.fetch({ limit: DISCOVERY_PAGE_SIZE });
    if (!reuseNewest && !newestBatch?.values) return [];
    const state = reuseNewest ? existing : {
        messages: new Map(),
        oldestId: newestBatch?.last?.()?.id || null,
        complete: (newestBatch?.size || 0) < DISCOVERY_PAGE_SIZE,
        newestCheckedAt: Date.now(),
    };
    if (!reuseNewest) mergeUsableMessages(state.messages, newestBatch.values(), botUserId);
    discoveryCache.set(cacheKey, state);

    // One Discord request for the immediate first paint. Full message history
    // is paginated by a separate task so switching channels never waits for it.
    if (!fullHistory) return sortedMessages(state);

    let before = state.complete ? null : state.oldestId;
    const seen = new Set();
    while (before && !seen.has(String(before))
        && (!shouldContinue || shouldContinue())) {
        seen.add(String(before));
        const batch = await channel.messages.fetch({ limit: DISCOVERY_PAGE_SIZE, before }).catch(() => null);
        if (!batch) break;
        if (!batch.size) { state.complete = true; break; }
        mergeUsableMessages(state.messages, batch.values(), botUserId);
        const oldest = batch.last?.();
        state.oldestId = oldest?.id || state.oldestId;
        if (typeof onBatch === 'function') {
            const valid = [...batch.values()].filter(message => isUsableMessage(message, botUserId));
            await onBatch(valid);
        }
        if (!oldest || batch.size < DISCOVERY_PAGE_SIZE) {
            state.complete = true;
            break;
        }
        before = oldest.id;
    }
    discoveryCache.set(cacheKey, state);
    return sortedMessages(state);
}

async function resolveChannel(guild, channelId) {
    return guild.channels.cache.get(String(channelId))
        || await guild.channels.fetch(String(channelId)).catch(() => null);
}

async function resolveGuildConfig(guild) {
    if (!guild?.client || !guild?.id) return null;
    return getGuildConfig(guild.client, guild.id).catch(() => null);
}

export async function discoverRecentChannelEmbeds(guild, channelId, botUserId) {
    if (!guild || !channelId || !botUserId) return [];
    const channel = await resolveChannel(guild, channelId);
    if (!channel?.messages?.fetch) return [];

    const [messages, guildConfig] = await Promise.all([
        getRecentUsableMessages(channel, botUserId, { fullHistory: false }),
        resolveGuildConfig(guild),
    ]);
    const records = messages.flatMap(message => buildRecords(guild, channel, message, guildConfig));
    recentChannelIndex.set(String(guild.id) + ':' + String(channel.id), {
        timestamp: Date.now(), records,
    });
    return records;
}

export async function discoverMissingChannelEmbeds(guild, channelId, botUserId, { onBatch = null, shouldContinue = null } = {}) {
    if (!guild || !channelId || !botUserId) return [];

    const channel = await resolveChannel(guild, channelId);
    if (!channel?.messages?.fetch) return [];

    const guildConfig = await resolveGuildConfig(guild);
    const messages = await getRecentUsableMessages(channel, botUserId, {
        fullHistory: true,
        onBatch: onBatch ? batch => onBatch(batch.flatMap(message => buildRecords(guild, channel, message, guildConfig))) : null,
        shouldContinue,
    });
    if (!messages.length) return [];

    // Do not persist historical discovery as manual Embed Builder records.
    // The inline snapshot is enough for instant preview and prevents old log
    // history from permanently polluting the registry/menu again.
    return messages.flatMap(message => buildRecords(guild, channel, message, guildConfig));
}

export async function discoverMissingChannelEmbed(guild, channelId, botUserId) {
    // A single live preview only needs the cache/newest page. Never perform an
    // exhaustive history walk on an interaction path.
    const records = await discoverRecentChannelEmbeds(guild, channelId, botUserId);
    const record = records[0] || null;
    if (!record) return null;

    const channel = await resolveChannel(guild, channelId);
    if (!channel?.messages?.fetch) return null;

    const message = channel.messages.cache.get(String(record.messageId))
        || await channel.messages.fetch(String(record.messageId)).catch(() => null);
    const embed = message?.embeds?.[Number(record.embedIndex || 0)] || null;
    if (!message || !embed) return null;

    return { channel, message, embed, record };
}

