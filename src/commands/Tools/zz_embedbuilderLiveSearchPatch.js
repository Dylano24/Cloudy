// CLOUDY_INTERACTION_LATENCY_V1
// BUILDER_SAVED_PARITY_V1
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} from 'discord.js';
import embedBuilderCommand from './embedbuilder.js';
import { filterEmbedBuilderRecords } from '../../utils/embedBuilderAccess.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    getEmbedRegistry,
    getEmbedRegistrySnapshot,
    resolveEmbedRegistryRecord,
} from '../../services/embedRegistryService.js';
import { collapseDisplayRecords, canonicalBuilderResponseTitle, getCanonicalBuilderRecords } from '../../services/embedManagerService.js';
import { warmSavedEmbedTemplateScopes, getCachedSavedEmbedTemplateData } from '../../services/embedTemplateService.js';
import { hydrateBuilderPreviewRecord } from '../../services/builderRuntimePreviewService.js';
import {
    getSearchableSystemCatalogRecords,
    getSystemSourceDefinitionPreview,
    getSystemSourceDefinitionPreviewForEmbed,
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
    'untitled embed',
    'use the buttons below to create your message',
    '(use the buttons below to create your message)',
]);
const pendingSelections = globalThis.__cloudyEmbedBuilderSearchSelections
    || (globalThis.__cloudyEmbedBuilderSearchSelections = new Map());
const CANONICAL_SEARCH_CACHE_TTL = 1500;
const canonicalSearchCache = globalThis.__cloudyEmbedCanonicalSearchCache
    || (globalThis.__cloudyEmbedCanonicalSearchCache = new Map());

async function getFastCanonicalBuilderRecords(guild) {
    const key = String(guild?.id || '');
    if (!key) return [];
    const now = Date.now();
    const cached = canonicalSearchCache.get(key);
    if (cached?.records && cached.expiresAt > now) return cached.records;
    if (cached?.promise) return cached.promise;

    const promise = getCanonicalBuilderRecords(guild)
        .then(records => {
            canonicalSearchCache.set(key, {
                records,
                expiresAt: Date.now() + CANONICAL_SEARCH_CACHE_TTL,
            });
            return records;
        })
        .catch(error => {
            canonicalSearchCache.delete(key);
            throw error;
        });
    canonicalSearchCache.set(key, { promise, expiresAt: now + CANONICAL_SEARCH_CACHE_TTL });
    return promise;
}

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
    const raw = record?.snapshot || getEmbedRegistrySnapshot(record) || {};
    const source = getSystemSourceDefinitionPreviewForEmbed(raw) || {};
    const complete = { ...source, ...raw };
    return getCachedSavedEmbedTemplateData(record?.guildId, record?.channelId, complete).data;
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
    if (record?.canonicalIdentity) return record;
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
    const candidates = [record?.previewRecord ? record?.name : null, data?.title, record?.name, record?.title]
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
    const statusTitle = canonicalBuilderResponseTitle(document.title);
    if (/^(?:failed|success|warning|error|information|invalid|expired|too fast|cooldown|on cooldown|please wait|slow down)$/.test(statusTitle)) return `status:${statusTitle}`;
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

function isInternalSearchRecord(record) {
    const title = normalize(recordTitle(record));
    const name = normalize(record?.name);
    return INTERNAL_SEARCH_TITLES.has(title)
        || INTERNAL_SEARCH_TITLES.has(name);
}

function builderSearchDisplayRecords(records) {
    // Search stays complete, but a canonical Cloudy template is shown only once.
    // Runtime/history mirrors are not separate editable Builder items.
    const unique = new Map();

    for (const rawRecord of records || []) {
        const record = sourceResolvedSearchRecord(rawRecord);
        const source = String(record?.source || '').toLowerCase();
        const channelId = String(record?.channelId || '');
        const messageId = String(record?.messageId || '');
        if (!channelId || !messageId) continue;

        if (['bot-history', 'history'].includes(source)) continue;
        if (record?.detached && source !== 'system-catalog') continue;
        if (isInternalSearchRecord(record)) continue;

        const stableKey = stableSearchTemplateKey(record);
        const stableContext = stableSearchTemplateContext(record);
        const title = normalize(recordTitle(record));

        const key = stableKey
            ? ['template', stableKey, stableContext].join(':')
            : source === 'system-catalog'
                ? ['catalog', stableContext, title].join(':')
                : [
                    'physical',
                    String(record?.backingChannelId || channelId),
                    messageId,
                    Number(record?.embedIndex || 0),
                ].join(':');

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

function canonicalSearchDynamicText(value = '') {
    return normalize(
        String(value || '')
            .replace(/\{dynamic\}/gi, ' dynamicvalue ')
            .replace(/<t:\d+(?::[tTdDfFR])?>/g, ' dynamicvalue ')
            .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, ' dynamicvalue ')
            .replace(/<a?:[^:>]+:\d+>/g, ' dynamicvalue ')
            .replace(/https?:\/\/\S+/gi, ' dynamicvalue ')
            .replace(/\$[\d,.]+|\b\d+(?:\.\d+)?%?\b/g, ' dynamicvalue ')
            .replace(/\b[a-z0-9]+(?:[-_][a-z0-9]+)+\b/gi, ' dynamicvalue '),
    );
}

function visibleSearchShape(value = {}) {
    const data = value?.toJSON ? value.toJSON() : (value || {});

    // Search identity is semantic, not decorative. Footer/logo/media/color can
    // differ between runtime copies of the same response without making a new
    // searchable response type.
    return {
        title: canonicalSearchDynamicText(data?.title),
        description: canonicalSearchDynamicText(data?.description),
        fields: Array.isArray(data?.fields)
            ? data.fields.map(field => ({
                name: canonicalSearchDynamicText(field?.name),
                value: canonicalSearchDynamicText(field?.value),
                inline: Boolean(field?.inline),
            }))
            : [],
    };
}

function searchContext(record, document = null) {
    return stableSearchTemplateContext(record)
        || normalize(document?.channel?.name)
        || normalize(record?.channelName)
        || normalize(record?.channelId);
}

function exactAutomatedSearchIdentity(record, document = null) {
    const source = String(record?.source || '').toLowerCase();
    if (source === 'embed-builder') return '';

    const stableContext = stableSearchTemplateContext(record);
    const definition = getSystemSourceDefinitionPreview(
        recordTitle(record),
        stableContext || searchContext(record, document),
    );
    const shape = definition
        ? visibleSearchShape(definition)
        : visibleSearchShape(snapshot(record));

    try {
        // Technical catalog metadata, physical message ids/channels and visual
        // decoration are not separate Search items. Meaningful text/fields are.
        return [
            definition ? 'definition' : 'visible',
            normalize(recordTitle(record)),
            JSON.stringify(shape),
        ].join(':');
    } catch {
        return '';
    }
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

function cleanChoiceText(value, max = 48) {
    return clean(
        String(value || '')
            .replace(/<a?:[^:>]+:\d+>/g, '')
            .replace(/<[@#&!]?\d+>/g, '')
            .replace(/\{dynamic\}/gi, '…')
            .replace(/[*_`~>|#]+/g, ' '),
        max,
    );
}

function choiceDetail(match) {
    const { record, document } = match;
    const data = snapshot(record);

    const description = String(data?.description || '')
        .split('\n')
        .map(line => cleanChoiceText(line, 48))
        .find(Boolean);
    if (description && normalize(description) !== normalize(document.title)) return description;

    const fieldName = (data?.fields || [])
        .map(field => cleanChoiceText(field?.name, 36))
        .find(Boolean);
    if (fieldName && normalize(fieldName) !== normalize(document.title)) return fieldName;

    const fieldValue = (data?.fields || [])
        .map(field => cleanChoiceText(field?.value, 42))
        .find(Boolean);
    if (fieldValue && normalize(fieldValue) !== normalize(document.title)) return fieldValue;

    const channelName = clean(document?.channel?.name, 30);
    if (channelName) return `#${channelName}`;
    return '';
}

export function buildSearchChoices(matches) {
    const list = Array.isArray(matches) ? matches : [];
    const titleCounts = new Map();

    for (const { document } of list) {
        const key = normalize(document?.title);
        titleCounts.set(key, (titleCounts.get(key) || 0) + 1);
    }

    const usedNames = new Map();

    return list.map(match => {
        const { record, document } = match;
        const title = clean(document?.title || 'Embed', 100);
        const titleKey = normalize(title);
        const duplicateCount = titleCounts.get(titleKey) || 0;

        let name = title;
        if (duplicateCount > 1) {
            const channelName = clean(document?.channel?.name, 24);
            const detail = choiceDetail(match);
            const parts = [
                title,
                channelName ? `#${channelName}` : '',
                detail && normalize(detail) !== normalize(channelName) ? detail : '',
            ].filter(Boolean);

            name = clean(parts.join(' • '), 100);
        }

        const baseName = name;
        const seen = usedNames.get(baseName) || 0;
        usedNames.set(baseName, seen + 1);

        if (seen > 0) {
            name = clean(
                `${baseName} • Variant ${seen + 1}`,
                100,
            );

            let collision = usedNames.get(name) || 0;
            while (collision > 0) {
                name = clean(`${baseName} • Variant ${seen + collision + 1}`, 100);
                collision = usedNames.get(name) || 0;
            }
            usedNames.set(name, 1);
        }

        return {
            name,
            value: selectionValue(record),
        };
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
        await warmSavedEmbedTemplateScopes(interaction.guildId, registryRecords.map(record => record.channelId));
        const records = filterEmbedBuilderRecords(interaction.guild, interaction.member,
            mergeSearchRecords(interaction.guildId, registryRecords), { requireSend: true });
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
            const records = filterEmbedBuilderRecords(interaction.guild, interaction.member,
                mergeSearchRecords(interaction.guildId, registryRecords), { requireSend: true });
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

                const initialSelection = {
                    record,
                    previewRecord,
                    sourceRecord: record.sourceRecord || null,
                    expiresAt: Date.now() + PENDING_TTL,
                };
                pendingSelections.set(selectionKey(interaction), initialSelection);
                // BUILDER_SEARCH_EDITOR_STATE_V2: Search state is available before the
                // Builder/editor starts, not only after a later Modify action.
                interaction.__cloudyInitialBuilderSelection = initialSelection;
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
