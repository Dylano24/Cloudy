import { MessageFlags } from 'discord.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from './cloudyBrandingService.js';

const DISCOVERY_PAGE_SIZE = 100;
const INTERNAL_TITLES = new Set([
    'message builder',
    'modify embed',
    'embed loaded',
    'changes saved',
    'could not load embeds',
]);
const discoveryCache = new Map();

function isUsableMessage(message, botUserId) {
    if (!message?.guildId || message.author?.id !== botUserId || !message.embeds?.length) return false;
    if (message.flags?.has?.(MessageFlags.Ephemeral)) return false;

    // Persistent slash-command replies are normal Cloudy embeds too. Older
    // discovery code rejected interaction replies, which made whole classes of
    // game/system embeds impossible to load in the Builder live preview.
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

function embedSnapshot(embed) {
    if (!embed) return null;
    const data = typeof embed.toJSON === 'function' ? embed.toJSON() : { ...embed };
    return data && typeof data === 'object' ? data : null;
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
                // Session-only discovery records deliberately behave as direct
                // editable embeds, not as persistent/system templates.
                source: 'embed-builder',
                title: String(embed?.title || '').slice(0, 256),
                name: recordName(embed),
                createdAt: message.createdAt?.toISOString?.() || new Date().toISOString(),
                discoveryPriority: candidatePriority(message),
                snapshot: embedSnapshot(embed),
            };
        })
        .filter(Boolean);
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

async function getRecentUsableMessages(channel, botUserId, { fullHistory = true } = {}) {
    const cacheKey = String(channel.id);
    const state = discoveryCache.get(cacheKey) || {
        messages: new Map(),
        oldestId: null,
        complete: false,
    };

    mergeUsableMessages(state.messages, channel.messages.cache.values(), botUserId);

    // Always refresh exactly one newest page first. This is the only network
    // fetch used by live channel switching in the Embed Builder.
    const newestBatch = await channel.messages.fetch({ limit: DISCOVERY_PAGE_SIZE }).catch(() => null);
    if (newestBatch?.size) {
        mergeUsableMessages(state.messages, newestBatch.values(), botUserId);
        if (!state.oldestId) state.oldestId = newestBatch.last()?.id || null;
        if (newestBatch.size < DISCOVERY_PAGE_SIZE) state.complete = true;
    }

    discoveryCache.set(cacheKey, state);

    // Live Builder selection must never wait for old history. Full-history mode
    // remains available for background/recovery callers only.
    if (!fullHistory) return sortedMessages(state);

    let before = state.complete ? null : state.oldestId;
    while (before) {
        const batch = await channel.messages.fetch({ limit: DISCOVERY_PAGE_SIZE, before }).catch(() => null);
        if (!batch) break;
        if (!batch.size) {
            state.complete = true;
            break;
        }

        mergeUsableMessages(state.messages, batch.values(), botUserId);
        const oldest = batch.last();
        state.oldestId = oldest?.id || state.oldestId;

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

export async function discoverRecentChannelEmbeds(guild, channelId, botUserId) {
    if (!guild || !channelId || !botUserId) return [];
    const channel = await resolveChannel(guild, channelId);
    if (!channel?.messages?.fetch) return [];

    const messages = await getRecentUsableMessages(channel, botUserId, { fullHistory: false });
    return messages.flatMap(message => buildRecords(guild, channel, message));
}

export async function discoverMissingChannelEmbeds(guild, channelId, botUserId) {
    if (!guild || !channelId || !botUserId) return [];

    const channel = await resolveChannel(guild, channelId);
    if (!channel?.messages?.fetch) return [];

    const messages = await getRecentUsableMessages(channel, botUserId, { fullHistory: true });
    if (!messages.length) return [];

    // Do not persist historical discovery as manual Embed Builder records.
    // The inline snapshot is enough for instant preview and prevents old log
    // history from permanently polluting the registry/menu again.
    return messages.flatMap(message => buildRecords(guild, channel, message));
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
