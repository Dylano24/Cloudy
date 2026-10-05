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
import { collapseDisplayRecords } from '../../services/embedManagerService.js';
import {
    getSearchableSystemCatalogRecords,
    getSystemSourceDefinitionPreview,
} from '../../services/systemEmbedCatalogService.js';

const RUNTIME_PATCH = Symbol.for('cloudy.embedbuilderLiveSearchRuntime');
const RESPONSE_PATCH = Symbol.for('cloudy.embedbuilderLiveSearchResponses');
const OLD_SEARCH_BUTTON_ID = '__cloudy_removed_builder_search_button__';
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
    return getEmbedRegistrySnapshot(record) || record?.snapshot || {};
}

function stableSearchTemplateKey(record) {
    const authorName = String(snapshot(record)?.author?.name || '').trim();
    const match = authorName.match(/^Cloudy template key:\s*([^|]+)/i);
    return String(match?.[1] || '').trim().toLowerCase();
}

function stableSearchTemplateContext(record) {
    const authorName = String(snapshot(record)?.author?.name || '').trim();
    const match = authorName.match(/\|\|\s*Cloudy context:\s*([^|]+)/i);
    return String(match?.[1] || '').trim().toLowerCase();
}

function sourceResolvedSearchRecord(record) {
    if (String(record?.source || '').toLowerCase() !== 'system-catalog') return record;

    const data = snapshot(record);
    const visibleTitle = clean(data?.title, 100);
    const visibleDescription = clean(data?.description, 256);
    if (!/^(?:success|error|information|warning)$/i.test(visibleTitle) || !visibleDescription) {
        return record;
    }

    const source = getSystemSourceDefinitionPreview(
        visibleDescription,
        stableSearchTemplateContext(record),
    );
    if (!source?.title || clean(source.title, 100).toLowerCase() !== visibleDescription.toLowerCase()) {
        return record;
    }

    const sourceSnapshot = {
        ...data,
        ...source,
        author: data?.author || source?.author || null,
    };

    return {
        ...record,
        title: source.title,
        name: source.title,
        snapshot: sourceSnapshot,
        sourceRecord: {
            ...record,
            title: source.title,
            name: source.title,
            snapshot: sourceSnapshot,
        },
        legacySearchAlias: {
            title: visibleTitle,
            description: visibleDescription,
        },
    };
}

function humanizeDynamicTitle(value) {
    const text = clean(value, 100);
    const possessive = text.match(/^(?:\{dynamic\}|[a-z0-9_.-]{2,32})'s\s+(.+)$/i);
    return possessive?.[1] ? clean(possessive[1], 100) : text;
}

function isTechnicalVisibleName(value) {
    const text = clean(value, 100);
    return /^cloudy template key:/i.test(text)
        || /^(?:source|embed):[a-z0-9_-]{6,}$/i.test(text)
        || /^(?:game|ticket-log):[a-z0-9:_-]+$/i.test(text);
}

export function recordTitle(record) {
    const data = snapshot(record);
    const candidates = [data?.title, record?.name, record?.title]
        .map(value => clean(value, 100))
        .filter(Boolean);

    for (const candidate of candidates) {
        if (!isTechnicalVisibleName(candidate)) return humanizeDynamicTitle(candidate);
    }

    const firstLine = String(data?.description || '')
        .split('\n')
        .map(line => clean(line.replace(/^[>\s#*_\`~|]+/, '').replace(/[*_\`~]/g, ''), 100))
        .find(Boolean);
    if (firstLine && !isTechnicalVisibleName(firstLine)) return firstLine;

    const firstFieldName = (data?.fields || [])
        .map(field => clean(field?.name, 100))
        .find(value => value && !isTechnicalVisibleName(value));
    if (firstFieldName) return firstFieldName;

    const footerText = clean(data?.footer?.text, 100);
    if (footerText && !isTechnicalVisibleName(footerText)) return footerText;

    const authorName = clean(data?.author?.name, 100);
    if (authorName && !isTechnicalVisibleName(authorName)) return authorName;

    return '';
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
    return `${record?.channelId}:${titleKey}`;
}

function priority(record) {
    const source = String(record?.source || '').toLowerCase();
    if (source === 'system-catalog') {
        const key = stableSearchTemplateKey(record);
        // Game/ticket masters are intentionally edited through their canonical
        // catalog cards. Generic source responses (FAQ, panels, helpers, etc.)
        // must target the real Discord message when one exists.
        if (/^(?:game|ticket-log):/.test(key)) return 100;
        return 30;
    }
    if (source.includes('template')) return 80;
    if (source.includes('modified')) return 60;
    if (source === 'history') return 20;
    return 40;
}

function chooseBetter(left, right) {
    if (!left) return right;

    // All candidates reaching this function already belong to the same logical
    // Builder item. Choose the correct Save target first, and preserve the best
    // search score from any peer only for result ordering.
    const bestScore = Math.max(left.score ?? 0, right.score ?? 0);
    const leftPriority = priority(left.record);
    const rightPriority = priority(right.record);
    if (rightPriority !== leftPriority) {
        const chosen = rightPriority > leftPriority ? right : left;
        return { ...chosen, score: bestScore };
    }

    if (right.score !== left.score) {
        const chosen = right.score > left.score ? right : left;
        return { ...chosen, score: bestScore };
    }

    const rightTime = new Date(right.record?.updatedAt || right.record?.createdAt || 0).getTime();
    const leftTime = new Date(left.record?.updatedAt || left.record?.createdAt || 0).getTime();
    const chosen = rightTime >= leftTime ? right : left;
    return { ...chosen, score: bestScore };
}

function mergeSearchRecords(guildId, registryRecords) {
    const combined = [
        ...(Array.isArray(registryRecords) ? registryRecords : []),
        ...getSearchableSystemCatalogRecords(guildId),
    ];
    const unique = new Map();
    for (const record of combined) {
        const key = [
            String(record?.backingChannelId || record?.channelId || ''),
            String(record?.messageId || ''),
            Number(record?.embedIndex || 0),
        ].join(':');
        const existing = unique.get(key);
        if (!existing || String(record?.source || '') === 'system-catalog') {
            unique.set(key, record);
        }
    }
    return [...unique.values()];
}

function builderSearchDisplayRecords(records) {
    // Search contains reusable templates plus embeds that are still real Builder
    // messages. Runtime notification/history copies are examples, not templates:
    // never expose them as separate Search results and never keep deleted channel
    // messages alive here.
    const unique = new Map();

    for (const rawRecord of records || []) {
        const record = sourceResolvedSearchRecord(rawRecord);
        const source = String(record?.source || '').toLowerCase();
        const channelId = String(record?.channelId || '');
        const messageId = String(record?.messageId || '');
        if (!channelId || !messageId) continue;

        if (['bot-history', 'history'].includes(source)) continue;
        if (record?.detached && source !== 'system-catalog') continue;

        const stableKey = stableSearchTemplateKey(record);
        const stableContext = stableSearchTemplateContext(record);
        const key = source === 'system-catalog' && stableKey
            ? ['template', stableKey, stableContext].join(':')
            : [
                'physical',
                String(record?.backingChannelId || channelId),
                messageId,
                Number(record?.embedIndex || 0),
            ].join(':');

        const existing = unique.get(key);
        if (!existing || priority(record) >= priority(existing)) {
            unique.set(key, record);
        }
    }

    return [...unique.values()];
}

export function latestRealPreviewRecord(guild, records, selectedRecord) {
    if (!selectedRecord) return null;
    if (selectedRecord.previewRecord) return selectedRecord.previewRecord;
    const selectedDocument = recordDocument(guild, selectedRecord);
    const key = logicalKey(selectedRecord, selectedDocument);

    return records
        .filter(record => String(record?.source || '').toLowerCase() !== 'system-catalog')
        .filter(record => logicalKey(record, recordDocument(guild, record)) === key)
        .sort((left, right) => {
            const leftTime = new Date(left?.updatedAt || left?.createdAt || 0).getTime();
            const rightTime = new Date(right?.updatedAt || right?.createdAt || 0).getTime();
            return leftTime - rightTime;
        })
        .at(-1) || null;
}

export function buildMatches(guild, records, query) {
    const hasQuery = Boolean(normalize(query));
    const matches = [];

    for (const record of builderSearchDisplayRecords(records)) {
        const document = recordDocument(guild, record);
        if (!document.title) continue;
        const score = hasQuery ? searchScore(document, query) : 0;
        if (hasQuery && score == null) continue;
        matches.push({ record, document, score });
    }

    return matches.sort((a, b) => {
        if (hasQuery && b.score !== a.score) return b.score - a.score;

        const priorityDelta = priority(b.record) - priority(a.record);
        if (priorityDelta) return priorityDelta;

        const titleDelta = a.document.title.localeCompare(
            b.document.title,
            undefined,
            { sensitivity: 'base' },
        );
        if (titleDelta) return titleDelta;

        return new Date(b.record?.updatedAt || b.record?.createdAt || 0).getTime()
            - new Date(a.record?.updatedAt || a.record?.createdAt || 0).getTime();
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
    const description = document.channel?.name
        ? `#${document.channel.name}`
        : 'Saved embed';

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

        // Empty autocomplete must stay empty. Search only starts after the user
        // types something; opening /embedbuilder must never dump a template list.
        if (!normalize(focused.value)) {
            await interaction.respond([]).catch(() => {});
            return;
        }

        const registryRecords = await getEmbedRegistry(interaction.guildId);
        const records = mergeSearchRecords(interaction.guildId, registryRecords);
        const matches = buildMatches(interaction.guild, records, focused.value).slice(0, 25);
        const titleCounts = new Map();
        for (const { document } of matches) {
            const title = normalize(document.title);
            titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
        }

        const seenTitleIndexes = new Map();
        const choices = matches.map(({ record, document }) => {
            const title = clean(document.title, 100);
            const normalizedTitle = normalize(title);
            const duplicateCount = titleCounts.get(normalizedTitle) || 0;
            if (duplicateCount <= 1) {
                return { name: title, value: selectionValue(record) };
            }

            const channelName = document.channel?.name ? `#${document.channel.name}` : '';
            const index = (seenTitleIndexes.get(normalizedTitle) || 0) + 1;
            seenTitleIndexes.set(normalizedTitle, index);
            const suffix = clean(
                channelName || (duplicateCount > 1 ? `${index}/${duplicateCount}` : ''),
                45,
            );
            return {
                name: clean(suffix ? `${title} • ${suffix}` : title, 100),
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
            const registryRecords = await getEmbedRegistry(interaction.guildId);
            const records = mergeSearchRecords(interaction.guildId, registryRecords);
            const displayRecords = builderSearchDisplayRecords(records);
            const record = displayRecords.find(item =>
                String(item.channelId) === selected.channelId
                && String(item.messageId) === selected.messageId
                && Number(item.embedIndex || 0) === selected.embedIndex,
            );
            if (record) {
                pendingSelections.set(selectionKey(interaction), {
                    record,
                    previewRecord: record.previewRecord
                        || latestRealPreviewRecord(interaction.guild, records, record),
                    sourceRecord: record.sourceRecord || null,
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
