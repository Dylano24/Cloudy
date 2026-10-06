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
    resolveEmbedRegistryRecord,
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
const INTERNAL_SEARCH_TITLES = new Set([
    'message builder',
    'modify embed',
    'embed loaded',
    'changes saved',
    'could not load embeds',
    'use the buttons below to create your message',
    '(use the buttons below to create your message)',
    'untitled embed',
]);
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
    // Search stays complete, but repeated copies of the same automated/template response are one searchable item.
    // Manual Builder embeds are always kept separate, even when title/content happen to match.
    const unique = new Map();

    for (const rawRecord of records || []) {
        const record = sourceResolvedSearchRecord(rawRecord);
        const source = String(record?.source || '').toLowerCase();
        const channelId = String(record?.channelId || '');
        const messageId = String(record?.messageId || '');
        if (!channelId || !messageId) continue;

        const historyOrCatalogPeer = ['system-catalog', 'bot-history', 'history'].includes(source);
        if (['bot-history', 'history'].includes(source)) continue;
        if (record?.detached && source !== 'system-catalog') continue;

        const visibleTitle = normalize(recordTitle(record));
        if (!visibleTitle || INTERNAL_SEARCH_TITLES.has(visibleTitle)) continue;

        const stableKey = stableSearchTemplateKey(record);
        const stableContext = stableSearchTemplateContext(record);
        const manual = source === 'embed-builder';

        const key = manual
            ? ['manual', String(record?.backingChannelId || channelId), messageId, Number(record?.embedIndex || 0)].join(':')
            : stableKey
                ? ['template', stableKey, stableContext].join(':')
                : historyOrCatalogPeer
                    ? ['catalog', stableContext, visibleTitle].join(':')
                    : ['physical', String(record?.backingChannelId || channelId), messageId, Number(record?.embedIndex || 0)].join(':');

        const existing = unique.get(key);
        if (!existing || priority(record) > priority(existing)) {
            unique.set(key, record);
            continue;
        }

        if (priority(record) === priority(existing)) {
            const currentTime = new Date(record?.updatedAt || record?.createdAt || 0).getTime();
            const existingTime = new Date(existing?.updatedAt || existing?.createdAt || 0).getTime();
            if (currentTime >= existingTime) unique.set(key, record);
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

function semanticSearchText(value = '') {
    let text = String(value || '')
        .replace(/<a?:[^:>]+:\d+>/gi, ' {dynamic} ')
        .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, ' {dynamic} ')
        .replace(/https?:\/\/\S+/gi, ' {dynamic} ')
        .replace(/\b\d{2,}\b/g, ' {dynamic} ')
        .replace(/\$[\d,.]+/g, ' {dynamic} ')
        .replace(/\b\d+(?:\.\d+)?%\b/g, ' {dynamic} ');

    // Task/job identifiers are runtime values, while words such as
    // "Scheduled task" and "Verification task" describe genuinely different responses.
    text = text.replace(
        /\btask\s+([a-z0-9_.-]+)\s+(?=(?:was\s+)?removed\b)/gi,
        (match, token) => /^(?:scheduled|verification|role|reward)$/i.test(token)
            ? match
            : 'Task {dynamic} ',
    );

    return normalize(text.replace(/\{dynamic\}/g, ' dynamic '));
}

function exactAutomatedSearchIdentity(record, document) {
    const source = String(record?.source || '').toLowerCase();
    if (source === 'embed-builder') return '';

    const data = snapshot(record);
    const title = normalize(document?.title || recordTitle(record));
    const description = semanticSearchText(data?.description || '');
    const fields = Array.isArray(data?.fields)
        ? data.fields.map(field => [
            semanticSearchText(field?.name || ''),
            semanticSearchText(field?.value || ''),
        ].join('=')).join('|')
        : '';

    // Deliberately ignore channel, footer, author metadata, logo/media and color:
    // those are presentation/placement details, not separate Search items.
    return [title, description, fields].join('::');
}

function readableDescriptionDetail(record) {
    const data = snapshot(record);
    const raw = clean(String(data?.description || '').split('\n').find(Boolean) || '', 72);
    if (!raw) return '';

    let detail = raw
        .replace(/<a?:[^:>]+:\d+>/gi, '')
        .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, '')
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

    const title = clean(recordTitle(record), 100);
    if (title && normalize(detail).startsWith(normalize(title))) {
        detail = detail.slice(title.length).replace(/^[\s:—–-]+/, '').trim();
    }

    detail = detail
        .replace(/\b\d{17,20}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const sentence = detail.split(/[.!?](?:\s|$)/)[0]?.trim() || detail;
    return clean(sentence, 46);
}

function choiceDetail(match) {
    const detail = readableDescriptionDetail(match?.record);
    if (detail) return detail;

    const channelName = clean(match?.document?.channel?.name || '', 40);
    if (channelName) return `#${channelName}`;
    return '';
}

function shortRecordId(record) {
    return String(record?.messageId || '').slice(-6);
}

function uniqueChoiceName(base, detail, usedNames, record) {
    const title = clean(base || 'Embed', 100);
    const primary = clean(detail ? `${title} • ${detail}` : title, 100);
    const primaryKey = normalize(primary);
    if (!usedNames.has(primaryKey)) {
        usedNames.set(primaryKey, 1);
        return primary;
    }

    const nextVariant = (usedNames.get(primaryKey) || 1) + 1;
    usedNames.set(primaryKey, nextVariant);

    const variant = clean(`${title} • Variant ${nextVariant}`, 100);
    const variantKey = normalize(variant);
    if (!usedNames.has(variantKey)) {
        usedNames.set(variantKey, 1);
        return variant;
    }

    // Deterministic tie-breaker only; raw IDs are never shown to the user.
    const stableOffset = Math.max(2, Number.parseInt(shortRecordId(record), 10) % 50 || nextVariant);
    const fallback = clean(`${title} • Variant ${stableOffset}`, 100);
    usedNames.set(normalize(fallback), 1);
    return fallback;
}

export function buildSearchChoices(matches) {
    const titleCounts = new Map();
    for (const match of matches || []) {
        const title = normalize(match?.document?.title);
        if (title) titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
    }

    const usedNames = new Map();
    return (matches || []).map(match => {
        const title = clean(match?.document?.title || 'Embed', 100);
        const duplicateCount = titleCounts.get(normalize(title)) || 0;
        const detail = duplicateCount > 1 ? choiceDetail(match) : '';
        const name = uniqueChoiceName(title, detail, usedNames, match?.record);
        return {
            name,
            value: selectionValue(match?.record),
        };
    });
}

export function buildMatches(guild, records, query) {
    const hasQuery = Boolean(normalize(query));
    const matches = [];
    const exactAutomated = new Map();

    for (const record of builderSearchDisplayRecords(records)) {
        const document = recordDocument(guild, record);
        if (!document.title) continue;
        const score = hasQuery ? searchScore(document, query) : 0;
        if (hasQuery && score == null) continue;

        const match = { record, document, score };
        const exactKey = exactAutomatedSearchIdentity(record, document);
        if (!exactKey) {
            matches.push(match);
            continue;
        }

        const existingIndex = exactAutomated.get(exactKey);
        if (existingIndex == null) {
            exactAutomated.set(exactKey, matches.length);
            matches.push(match);
            continue;
        }

        matches[existingIndex] = chooseBetter(matches[existingIndex], match);
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

async function hydrateLiveSearchRecord(guild, record) {
    if (!guild || !record || record.detached || String(record.source || '').toLowerCase() === 'system-catalog') {
        return record;
    }

    const resolved = await resolveEmbedRegistryRecord(guild, record).catch(() => null);
    if (!resolved?.message || !resolved?.embed) return record;

    return {
        ...record,
        snapshot: resolved.embed.toJSON?.() || record.snapshot,
        components: (resolved.message.components || []).map(row => row?.toJSON ? row.toJSON() : row),
        source: record.source || 'reconciled',
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
        const choices = buildSearchChoices(matches);

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
                const liveCandidate = record.previewRecord
                    || latestRealPreviewRecord(interaction.guild, records, record)
                    || (String(record.source || '').toLowerCase() !== 'system-catalog' ? record : null);
                const previewRecord = liveCandidate
                    ? await hydrateLiveSearchRecord(interaction.guild, liveCandidate)
                    : null;

                pendingSelections.set(selectionKey(interaction), {
                    record,
                    previewRecord,
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
