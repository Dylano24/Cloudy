import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} from 'discord.js';
import embedBuilderCommand from './embedbuilder.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    getEmbedRegistry,
    getEmbedRegistrySnapshot,
} from '../../services/embedRegistryService.js';

const RUNTIME_PATCH = Symbol.for('cloudy.embedbuilderLiveSearchRuntime');
const RESPONSE_PATCH = Symbol.for('cloudy.embedbuilderLiveSearchResponses');
const OLD_SEARCH_BUTTON_ID = 'simple_embed_title_search';
const PENDING_TTL = 5 * 60_000;
const pendingSelections = globalThis.__cloudyEmbedBuilderSearchSelections
    || (globalThis.__cloudyEmbedBuilderSearchSelections = new Map());

function normalize(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/<a?:[^:>]+:\d+>/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function clean(value, max = 100) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function snapshot(record) {
    return getEmbedRegistrySnapshot(record) || {};
}

function recordTitle(record) {
    const data = snapshot(record);
    return clean(record?.name || record?.title || data?.title || 'Untitled embed', 100);
}

function recordDocument(guild, record) {
    const data = snapshot(record);
    const channel = guild?.channels?.cache?.get?.(String(record?.channelId || '')) || null;
    const fields = Array.isArray(data.fields)
        ? data.fields.flatMap(field => [field?.name, field?.value])
        : [];
    const title = recordTitle(record);
    const titleKey = normalize([title, record?.name, record?.title, data?.title].filter(Boolean).join(' '));
    const bodyKey = normalize([
        data?.description,
        data?.author?.name,
        data?.footer?.text,
        channel?.name,
        channel?.parent?.name,
        record?.source,
        ...fields,
    ].filter(Boolean).join(' '));

    return {
        title,
        titleKey,
        bodyKey,
        allKey: `${titleKey} ${bodyKey}`.trim(),
        channel,
    };
}

function editDistance(left, right, maximum = 3) {
    const a = String(left || '');
    const b = String(right || '');
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    if (Math.abs(a.length - b.length) > maximum) return maximum + 1;

    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    let current = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i += 1) {
        current[0] = i;
        let rowMinimum = current[0];
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + cost,
            );
            rowMinimum = Math.min(rowMinimum, current[j]);
        }
        if (rowMinimum > maximum) return maximum + 1;
        [previous, current] = [current, previous];
    }
    return previous[b.length];
}

function wordScore(queryToken, candidateToken) {
    if (!queryToken || !candidateToken) return 0;
    if (queryToken === candidateToken) return 1000;
    if (candidateToken.startsWith(queryToken)) return 850;
    if (candidateToken.includes(queryToken)) return queryToken.length >= 2 ? 650 : 0;
    if (queryToken.length < 3 || candidateToken.length < 3) return 0;

    const maxDistance = Math.max(queryToken.length, candidateToken.length) <= 6 ? 1 : 2;
    const distance = editDistance(queryToken, candidateToken, maxDistance);
    if (distance > maxDistance) return 0;
    return 450 - (distance * 75);
}

function searchScore(document, rawQuery) {
    const query = normalize(rawQuery);
    if (!query) return 0;

    if (document.titleKey === query) return 100000;
    if (document.titleKey.startsWith(query)) return 90000;

    const queryTokens = query.split(' ').filter(Boolean);
    const titleTokens = document.titleKey.split(' ').filter(Boolean);
    const bodyTokens = document.bodyKey.split(' ').filter(Boolean);
    let total = 0;

    for (const queryToken of queryTokens) {
        let bestTitle = 0;
        let bestBody = 0;
        for (const token of titleTokens) bestTitle = Math.max(bestTitle, wordScore(queryToken, token));
        for (const token of bodyTokens) bestBody = Math.max(bestBody, wordScore(queryToken, token));
        const best = Math.max(bestTitle, Math.floor(bestBody * 0.7));
        if (!best) return null;
        total += bestTitle * 10 + bestBody * 3;
    }

    if (document.titleKey.includes(query)) total += 25000;
    else if (document.allKey.includes(query)) total += 10000;
    return total;
}

function logicalKey(record, document) {
    const titleKey = normalize(document.title) || `${record?.messageId}:${record?.embedIndex || 0}`;
    if (String(record?.source || '').toLowerCase() === 'system-catalog') {
        // Bot-code templates are global identities. They are intentionally not
        // tied to the channel where a catalog copy happens to be stored.
        return `bot:${titleKey}`;
    }
    return `${record?.channelId}:${titleKey}`;
}

function priority(record) {
    const source = String(record?.source || '').toLowerCase();
    if (source === 'system-catalog') return 100;
    if (source.includes('template')) return 80;
    if (source.includes('modified')) return 60;
    if (source === 'history') return 20;
    return 40;
}

function chooseBetter(left, right) {
    if (!left) return right;
    if (right.score !== left.score) return right.score > left.score ? right : left;
    if (priority(right.record) !== priority(left.record)) {
        return priority(right.record) > priority(left.record) ? right : left;
    }
    const rightTime = new Date(right.record?.updatedAt || right.record?.createdAt || 0).getTime();
    const leftTime = new Date(left.record?.updatedAt || left.record?.createdAt || 0).getTime();
    return rightTime >= leftTime ? right : left;
}

function buildMatches(guild, records, query) {
    const grouped = new Map();
    const hasQuery = Boolean(normalize(query));

    for (const record of records) {
        const document = recordDocument(guild, record);
        const score = hasQuery ? searchScore(document, query) : 0;
        if (hasQuery && score == null) continue;
        const candidate = { record, document, score };
        const key = logicalKey(record, document);
        grouped.set(key, chooseBetter(grouped.get(key), candidate));
    }

    return [...grouped.values()].sort((a, b) => {
        if (hasQuery && b.score !== a.score) return b.score - a.score;

        const aBot = String(a.record?.source || '').toLowerCase() === 'system-catalog';
        const bBot = String(b.record?.source || '').toLowerCase() === 'system-catalog';
        if (!hasQuery && aBot !== bBot) return aBot ? -1 : 1;

        return a.document.title.localeCompare(b.document.title, undefined, { sensitivity: 'base' });
    });
}

function selectionValue(record) {
    return [record?.channelId, record?.messageId, Number(record?.embedIndex || 0)].join(':').slice(0, 100);
}

function parseSelection(value) {
    const match = String(value || '').match(/^(\d+):(\d+):(\d+)$/);
    if (!match) return null;
    return {
        channelId: match[1],
        messageId: match[2],
        embedIndex: Number(match[3] || 0),
    };
}

function selectionKey(interaction) {
    return `${interaction?.guildId || interaction?.guild?.id || 'dm'}:${interaction?.user?.id || 'unknown'}`;
}

function removeExpiredSelections() {
    const now = Date.now();
    for (const [key, value] of pendingSelections.entries()) {
        if (!value || value.expiresAt <= now) pendingSelections.delete(key);
    }
}

function componentId(component) {
    const data = component?.toJSON ? component.toJSON() : component?.data || component;
    return String(data?.custom_id || data?.customId || '');
}

function stripOldModalSearch(payload) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.components)) return payload;
    const nextRows = [];
    for (const row of payload.components) {
        const data = row?.toJSON ? row.toJSON() : row;
        const components = (data?.components || []).filter(component => componentId(component) !== OLD_SEARCH_BUTTON_ID);
        if (!components.length) continue;
        nextRows.push({ ...data, components });
    }
    return { ...payload, components: nextRows };
}

function isModifyPayload(payload) {
    return (payload?.embeds || []).some(embed => {
        const data = embed?.toJSON ? embed.toJSON() : embed;
        return String(data?.title || '').trim().toLowerCase() === 'modify embed';
    });
}

function buildDirectSelectionPayload(interaction, payload, pending) {
    const record = pending.record;
    const document = recordDocument(interaction.guild, record);
    const isBotCode = String(record?.source || '').toLowerCase() === 'system-catalog';
    const description = isBotCode
        ? 'Bot code • global template'
        : `${document.channel?.name ? `#${document.channel.name}` : 'Saved embed'}`;

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`simple_embed_modify_embed:${record.channelId}:0`)
        .setPlaceholder(clean(document.title || 'Select embed', 100))
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(clean(document.title || 'Embed', 100))
                .setDescription(clean(description, 100))
                .setValue(`${record.messageId}:${Number(record.embedIndex || 0)}`),
        );

    return {
        ...payload,
        components: [new ActionRowBuilder().addComponents(menu)],
    };
}

function patchResponses() {
    if (InteractionHelper[RESPONSE_PATCH]) return;
    const previous = InteractionHelper.patchInteractionResponses.bind(InteractionHelper);

    InteractionHelper.patchInteractionResponses = function patchLiveEmbedSearch(interaction) {
        previous(interaction);
        if (!interaction || interaction.__cloudyLiveEmbedSearchPatched) return;

        for (const method of ['reply', 'editReply', 'followUp', 'update']) {
            const original = interaction[method]?.bind(interaction);
            if (!original) continue;
            interaction[method] = async (payload, ...args) => {
                removeExpiredSelections();
                let next = stripOldModalSearch(payload);
                const key = selectionKey(interaction);
                const pending = pendingSelections.get(key);
                if (pending && isModifyPayload(next)) {
                    next = buildDirectSelectionPayload(interaction, next, pending);
                    pendingSelections.delete(key);
                }
                return original(next, ...args);
            };
        }

        interaction.__cloudyLiveEmbedSearchPatched = true;
    };

    Object.defineProperty(InteractionHelper, RESPONSE_PATCH, {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
    });
}

if (!embedBuilderCommand[RUNTIME_PATCH]) {
    patchResponses();

    embedBuilderCommand.autocomplete = async function liveEmbedAutocomplete(interaction) {
        if (!interaction.guildId || !interaction.guild) {
            await interaction.respond([]).catch(() => {});
            return;
        }

        const focused = interaction.options.getFocused(true);
        if (focused?.name !== 'search') {
            await interaction.respond([]).catch(() => {});
            return;
        }

        const records = await getEmbedRegistry(interaction.guildId);
        const matches = buildMatches(interaction.guild, records, focused.value).slice(0, 25);
        const choices = matches.map(({ record, document }) => {
            const botCode = String(record?.source || '').toLowerCase() === 'system-catalog';
            const prefix = botCode
                ? 'Bot code • '
                : (document.channel?.name ? `#${document.channel.name} • ` : 'Embed • ');
            return {
                name: clean(`${prefix}${document.title}`, 100),
                value: selectionValue(record),
            };
        });

        await interaction.respond(choices).catch(() => {});
    };

    const originalExecute = embedBuilderCommand.execute.bind(embedBuilderCommand);
    embedBuilderCommand.execute = async function executeWithLiveSearch(interaction, ...args) {
        removeExpiredSelections();
        const rawSelection = interaction.options?.getString?.('search') || '';
        const selected = parseSelection(rawSelection);

        if (selected && interaction.guildId) {
            const records = await getEmbedRegistry(interaction.guildId);
            const record = records.find(item =>
                String(item.channelId) === selected.channelId
                && String(item.messageId) === selected.messageId
                && Number(item.embedIndex || 0) === selected.embedIndex,
            );
            if (record) {
                pendingSelections.set(selectionKey(interaction), {
                    record,
                    expiresAt: Date.now() + PENDING_TTL,
                });
            }
        }

        return originalExecute(interaction, ...args);
    };

    Object.defineProperty(embedBuilderCommand, RUNTIME_PATCH, {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
    });
}

export default {};
