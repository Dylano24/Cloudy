import { commercialBuilderTitle } from '../../utils/builderCommercialTitle.js';
import { getTicketLogTemplate } from '../../utils/ticket/ticketLogTemplates.js';
export { commercialBuilderTitle } from '../../utils/builderCommercialTitle.js';
// CLOUDY_INTERACTION_LATENCY_V1
// BUILDER_SAVED_PARITY_V1
import {
    MessageFlags,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} from 'discord.js';
import embedBuilderCommand from './embedbuilder.js';
import { logger } from '../../utils/logger.js';
import { performance } from 'node:perf_hooks';
import { createBuilderPerformanceTracker } from '../../utils/interactionLatency.js';
import { canUseEmbedBuilderChannel } from '../../utils/embedBuilderAccess.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    getEmbedRegistry,
    getEmbedRegistryGeneration,
    getEmbedRegistrySnapshot,
    peekEmbedRegistry,
    resolveEmbedRegistryRecord,
} from '../../services/embedRegistryService.js';
import { canonicalBuilderResponseTitle, getCanonicalBuilderRecords } from '../../services/embedManagerService.js';
import { warmSavedEmbedTemplateScopes, getCachedSavedEmbedTemplateData } from '../../services/embedTemplateService.js';
import { hydrateBuilderPreviewRecord } from '../../services/builderRuntimePreviewService.js';
import { FAQ_AI_BUTTON_ID } from '../../services/faqAiService.js';
import { FIX_GUIDE_ASK_BUTTON_ID } from '../../events/cloudyOwnerAssistantReady.js';
import {
    ensureSystemEmbedCatalogs,
    ensureHiddenBuilderCatalogLoaded,
    isSystemCatalogHiddenFromBuilder,
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
const CANONICAL_SEARCH_CACHE_TTL = 10_000;
const canonicalSearchCache = globalThis.__cloudyEmbedCanonicalSearchCache
    || (globalThis.__cloudyEmbedCanonicalSearchCache = new Map());

// A confirmed Delete starts before Discord REST and durable registry writes.
// Exclude its exact message from *every* autocomplete path immediately, even
// if a previous Search snapshot is still cached. Failed Delete rolls back.
// Keep a short post-commit guard against in-flight stale canonical scans.
const hiddenSearchDeleteTargets = new Map();
const CONFIRMED_DELETE_SEARCH_GUARD_MS = 5 * 60_000;

function pendingSearchDeleteMatches(record, target) {
    if (String(record?.guildId || '') !== target.guildId
        || String(record?.messageId || '') !== target.messageId) return false;
    const backing = String(record?.backingChannelId || record?.channelId || '');
    if (backing !== target.backingChannelId
        && String(record?.channelId || '') !== target.channelId) return false;
    return target.embedIndex === null
        || Number(record.embedIndex || 0) === target.embedIndex;
}

function isSearchDeleteHidden(record) {
    const now = Date.now();
    for (const [token, target] of hiddenSearchDeleteTargets) {
        if (target.expiresAt && target.expiresAt <= now) {
            hiddenSearchDeleteTargets.delete(token);
            continue;
        }
        if (pendingSearchDeleteMatches(record, target)) return true;
    }
    return false;
}

export function beginBuilderSearchDeletion(guildId, selected) {
    const id = String(guildId || '');
    const messageId = String(selected?.messageId || '');
    const channelId = String(selected?.channelId || '');
    if (!id || !messageId || !channelId) return () => {};
    const token = Symbol('builder-confirm-delete');
    hiddenSearchDeleteTargets.set(token, {
        guildId: id, messageId, channelId,
        backingChannelId: String(selected.backingChannelId || channelId),
        // Catalog Delete hides only this one virtual definition. Deleting a
        // real Discord message also removes all of its sibling embed indices.
        embedIndex: selected.source === 'system-catalog'
            ? Math.max(0, Number(selected.embedIndex) || 0) : null,
        expiresAt: null,
    });
    invalidateBuilderSearchTitleCache(id);
    return (committed = false) => {
        const target = hiddenSearchDeleteTargets.get(token);
        if (!target) return;
        if (committed) {
            target.expiresAt = Date.now() + CONFIRMED_DELETE_SEARCH_GUARD_MS;
        } else {
            hiddenSearchDeleteTargets.delete(token);
        }
        invalidateBuilderSearchTitleCache(id);
    };
}

// An explicit Save changes the title of an existing logical embed, not its
// identity. Drop stale query/canonical snapshots so the next autocomplete
// uses the updated registry and persistent title overlay immediately.
export function invalidateBuilderSearchTitleCache(guildId) {
    const key = String(guildId || '');
    if (!key) return;
    fastSearchCache.delete(key);
    canonicalSearchCache.delete(key);
    lastRegistrySearchRefresh.delete(key);
    lastCanonicalSearchRefresh.delete(key);
    lastCatalogSearchWarm.delete(key);
    for (const offeredKey of recentSearchSelections.keys()) {
        if (offeredKey.startsWith(key + ':')) recentSearchSelections.delete(offeredKey);
    }
    for (const offeredKey of pendingSelections.keys()) {
        if (offeredKey.startsWith(key + ':')) pendingSelections.delete(offeredKey);
    }
}

async function getFastCanonicalBuilderRecords(guild, suppliedRecords = null) {
    const key = String(guild?.id || '');
    if (!key) return [];
    const now = Date.now();
    const cached = canonicalSearchCache.get(key);
    const generation = getEmbedRegistryGeneration(key);
    if (cached?.generation === generation && cached?.records && cached.expiresAt > now) return cached.records;
    if (cached?.generation === generation && cached?.promise) return cached.promise;

    const promise = getCanonicalBuilderRecords(guild, suppliedRecords)
        .then(records => {
            // A Save/Delete can invalidate this cache while the canonical
            // scan is still running. Do not restore a stale snapshot after
            // the new title/deletion has already been confirmed.
            if (generation === getEmbedRegistryGeneration(key)
                && canonicalSearchCache.get(key)?.promise === promise) {
                canonicalSearchCache.set(key, {
                    generation,
                    records,
                    expiresAt: Date.now() + CANONICAL_SEARCH_CACHE_TTL,
                });
            }
            return records;
        })
        .catch(error => {
            if (canonicalSearchCache.get(key)?.promise === promise) canonicalSearchCache.delete(key);
            throw error;
        });
    // Keep the last known canonical set while the refresh is in flight so the
    // autocomplete fast path can read it without waiting.
    canonicalSearchCache.set(key, { generation, promise, records: cached?.records || null, expiresAt: now + CANONICAL_SEARCH_CACHE_TTL });
    return promise;
}

function peekCanonicalBuilderRecords(guild) {
    const guildId = String(guild?.id || '');
    const cached = canonicalSearchCache.get(guildId);
    return cached?.generation === getEmbedRegistryGeneration(guildId)
        && Array.isArray(cached.records) ? cached.records : [];
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

let autocompleteSnapshots = null;

function savedSearchSnapshot(record) {
    const remembered = record && autocompleteSnapshots?.get(record);
    if (remembered) return remembered;
    const raw = record?.snapshot || getEmbedRegistrySnapshot(record) || {};
    // An explicitly saved manual Builder post owns its exact title. Do not
    // let a similarly named global bot response overlay rename it in Search.
    if (record?.manualSaved && String(record.source || '') === 'embed-builder') {
        const result = { matched: false, data: raw };
        autocompleteSnapshots?.set(record, result);
        return result;
    }
    const source = getSystemSourceDefinitionPreviewForEmbed(raw) || {};
    const complete = { ...source, ...raw };
    const result = getCachedSavedEmbedTemplateData(record?.guildId, record?.channelId, complete);
    if (record) autocompleteSnapshots?.set(record, result);
    return result;
}

function snapshot(record) {
    return savedSearchSnapshot(record).data;
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

function rawRecordTitle(record) {
    const resolved = savedSearchSnapshot(record);
    const data = resolved.data;
    // After an explicit Builder Save the stored title wins over old names
    // attached to catalog/preview records. This is display-only; physical
    // message IDs and stable template keys remain untouched.
    if (resolved.matched && data?.title) return humanizeDynamicTitle(clean(data.title, 100));
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

// Ticket names/IDs are runtime instance data, not new editable templates.
// Keep every real event and its fields in ticket-logs and the registry; only
// Search presents one canonical choice per automated event family.
function automatedTicketLogFamily(record) {
    // Legacy ticket bot events may have a manualSaved registry flag even
    // though they were automatically emitted. Only actual Builder-authored
    // posts are exempt. An explicit saved template overlay is still respected.
    if (!record || String(record.source || '').toLowerCase() === 'embed-builder') return null;
    const saved = savedSearchSnapshot(record);
    if (saved.matched) return null; // the owner's explicit Save always wins
    const source = record?.snapshot || getEmbedRegistrySnapshot(record) || {};
    const structured = getTicketLogTemplate(source);
    if (structured) return { key: structured.key, title: structured.label };

    // Older emitted ticket logs had the ticket's name appended to the title
    // and sometimes lacked stable field metadata. Restrict this fallback
    // to automatic bot records; never collapse manually posted Builder embeds.
    const title = String(source.title || record.title || record.name || '').trim();
    const match = title.match(/^Ticket (created|closed|deleted|claimed|unclaimed|pinned|unpinned|reopened):\s*\S/i);
    if (!match) return null;
    const key = match[1].toLowerCase();
    return { key: key === 'created' ? 'open' : key === 'closed' ? 'close'
        : key === 'deleted' ? 'delete' : key === 'claimed' ? 'claim'
        : key === 'unclaimed' ? 'unclaim' : key === 'pinned' ? 'pin'
        : key === 'unpinned' ? 'unpin' : 'reopen',
    title: 'Ticket ' + key };
}

export function recordTitle(record) {
    // Automatic ticket instances share one event type in Search, including
    // legacy bot registrations marked manualSaved. Explicit owner template
    // overrides and manually posted Builder messages remain untouched.
    const ticketFamily = automatedTicketLogFamily(record);
    if (ticketFamily) return ticketFamily.title;
    // A deliberate Save is authoritative. Search must not silently strip
    // custom emojis or change the capitalization the owner just saved.
    const saved = savedSearchSnapshot(record);
    // On a bot-owned reusable template, the latest durable Save overlay wins
    // over legacy registry rows whose manualSaved flag and original snapshot
    // were never refreshed. Genuine Builder-authored posts retain their exact
    // individual physical titles.
    if (saved.matched && saved.data?.title
        && String(record?.source || '').toLowerCase() !== 'embed-builder') {
        return clean(saved.data.title, 100);
    }
    if (record?.manualSaved && record?.snapshot?.title) {
        // A Save to an otherwise dynamic numbered response (e.g. New report
        // #22) does not create an extra Search item per case number. Keep the
        // generic response family unless its title is an actual custom label.
        const raw = clean(record.snapshot.title, 100);
        if (!/^(?:new )?(?:report|ticket|case)\s*#?\d+$/i.test(raw)) return raw;
    }
    if (saved.matched && saved.data?.title) return clean(saved.data.title, 100);
    return commercialBuilderTitle(rawRecordTitle(record));
}

function recordDocument(guild, record) {
    const resolved = savedSearchSnapshot(record);
    const data = resolved.data;
    const channel = guild?.channels?.cache?.get?.(String(record?.channelId || '')) || null;
    const fields = Array.isArray(data.fields)
        ? data.fields.flatMap(field => [field?.name, field?.value])
        : [];
    const title = recordTitle(record);
    const rawTitle = normalize([record?.name, record?.title, data?.title].filter(Boolean).join(' '));
    const aliases = /\bremoved from builder\b/.test(rawTitle) ? ['deleted from builder'] : [];
    // Old aliases are retained internally to match the same saved response
    // family, but must not appear as a second/current Search title.
    const titleKey = resolved.matched
        ? normalize([title, data?.title].filter(Boolean).join(' '))
        : normalize([title, record?.name, record?.title, data?.title, ...aliases].filter(Boolean).join(' '));
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
    // Once a catalog response has been deliberately saved, its edited title
    // is the one canonical Search entry, not the unsaved code-definition name.
    if (record?.manualSaved === true
        && !/^(?:new )?(?:report|ticket|case)\s*#?\d+$/i.test(
            String(record?.snapshot?.title || record?.title || '').trim())) return 130;
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

function searchRecordRichness(record) {
    let score = 0;
    if (record?.canonicalIdentity) score += 8;
    if (record?.previewRecord) score += 4;
    if (record?.sourceRecord) score += 2;
    if (record?.snapshot) score += 1;
    return score;
}

function searchRelatedRecordAccessible(guild, member, record, { requireSend = true } = {}) {
    if (!record || String(record.guildId || '') !== String(guild?.id || '')) return false;
    const source = String(record.source || '').toLowerCase();

    // System catalog messages are stored in Cloudy's private internal catalog.
    // That backing channel is implementation detail and must never decide
    // whether a legitimate Builder Search result exists.
    if (source === 'system-catalog') return true;

    const logicalChannelId = String(record.channelId || '');
    if (!logicalChannelId) return false;
    return canUseEmbedBuilderChannel(guild, member, logicalChannelId, { requireSend });
}

function sanitizeSearchRecordAccess(guild, member, record, options = {}) {
    if (isSearchDeleteHidden(record)
        || !searchRelatedRecordAccessible(guild, member, record, options)) return null;

    const sanitizeRelated = related => {
        if (!related) return null;
        return searchRelatedRecordAccessible(guild, member, related, options)
            ? related
            : null;
    };

    const previewRecord = sanitizeRelated(record.previewRecord);
    const sourceRecord = sanitizeRelated(record.sourceRecord);

    return {
        ...record,
        ...(record.previewRecord ? { previewRecord } : {}),
        ...(record.sourceRecord ? { sourceRecord } : {}),
    };
}

export function filterEmbedBuilderSearchRecords(guild, member, records, options = {}) {
    return (Array.isArray(records) ? records : [])
        .map(record => sanitizeSearchRecordAccess(guild, member, record, options))
        .filter(Boolean);
}

const SEARCH_CATALOG_WARMUP_WAIT_MS = 700;

async function warmSystemCatalogForSearch(client) {
    if (!client) return false;

    // Startup normally owns catalog creation. Search also starts/retries it so
    // ephemeral Builder responses never disappear just because startup catalog
    // initialization was late or had a transient failure. Bound the wait to
    // keep Discord autocomplete comfortably inside its response window.
    const initialization = ensureSystemEmbedCatalogs(client)
        .then(() => true)
        .catch(() => false);

    let timer;
    const ready = await Promise.race([
        initialization,
        new Promise(resolve => {
            timer = setTimeout(() => resolve(false), SEARCH_CATALOG_WARMUP_WAIT_MS);
            timer.unref?.();
        }),
    ]).finally(() => {
        if (timer) clearTimeout(timer);
    });

    // If the bounded wait elapsed, initialization intentionally keeps running;
    // ensureSystemEmbedCatalogs owns/caches that same promise.
    return ready;
}

const FAST_SEARCH_CACHE_TTL = 30_000;
const fastSearchCache = globalThis.__cloudyEmbedFastSearchCache
    || (globalThis.__cloudyEmbedFastSearchCache = new Map());
const lastRegistrySearchRefresh = new Map();
const lastCanonicalSearchRefresh = new Map();
const lastCatalogSearchWarm = new Map();

// Load the saved index and title scopes at startup, rather than making the
// owner's first Search query discover them after an empty/partial response.
export async function prewarmEmbedBuilderSearch(guild) {
    const records = await getEmbedRegistry(guild.id, { cached: true });
    await Promise.all([
        warmSavedEmbedTemplateScopes(guild.id, records.map(record => record.channelId)),
        ensureHiddenBuilderCatalogLoaded(guild.id),
    ]);
    await getFastCanonicalBuilderRecords(guild, records);
    fastSearchCache.delete(String(guild.id));
    return loadFastEmbedBuilderSearchRecords({ guild, guildId: guild.id, member: guild.members?.me });
}

// Discord autocomplete has a short, non-deferable deadline. Database and
// full-catalog refreshes are scheduled AFTER replying, never per keystroke.
function scheduleAutocompleteSearchRefresh(interaction) {
    const guildId = String(interaction.guildId || '');
    if (!guildId) return;
    const now = Date.now();
    if (now - (lastCatalogSearchWarm.get(guildId) || 0) < 10_000) return;
    lastCatalogSearchWarm.set(guildId, now);

    const timer = setTimeout(() => {
        // Cold autocomplete may never await PostgreSQL. Warm the saved shared
        // title overlay *after* responding so the next query sees the owner's
        // last Save, including its emoji, without breaking the fast path.
        void warmSavedEmbedTemplateScopes(guildId, []).then(() => {
            fastSearchCache.delete(guildId);
        }).catch(error => logger.debug(
            '[EMBED_SEARCH] Saved title background warm skipped: ' + (error?.message || error),
        ));
        void ensureHiddenBuilderCatalogLoaded(guildId).catch(error =>
            logger.warn('[EMBED_SEARCH] Hidden templates refresh failed: ' + error?.message));
        void warmSystemCatalogForSearch(interaction.client).catch(error =>
            logger.warn('[EMBED_SEARCH] Catalog warmup failed: ' + error?.message));

        if (now - (lastRegistrySearchRefresh.get(guildId) || 0) >= 15_000) {
            lastRegistrySearchRefresh.set(guildId, now);
            void getEmbedRegistry(guildId, { cached: true }).then(() => {
                const existing = fastSearchCache.get(guildId);
                if (existing?.registryPending) fastSearchCache.delete(guildId);
            }).catch(error => logger.warn('[EMBED_SEARCH] Registry refresh failed: ' + error?.message));
        }
        if (now - (lastCanonicalSearchRefresh.get(guildId) || 0) >= 60_000) {
            lastCanonicalSearchRefresh.set(guildId, now);
            void getFastCanonicalBuilderRecords(interaction.guild).catch(error =>
                logger.warn('[EMBED_SEARCH] Canonical refresh failed: ' + error?.message));
        }
    }, 0);
    timer.unref?.();
}

export async function loadFastEmbedBuilderSearchRecords(interaction) {
    const guildId = String(interaction.guildId || '');
    const now = Date.now();
    const generation = getEmbedRegistryGeneration(guildId);
    const cached = fastSearchCache.get(guildId);

    // First reuse the indexed source list: do not clone 3,000+ registry rows or
    // warm a Discord catalog while somebody types the next character.
    if (cached?.generation === generation && cached?.records?.length && cached.expiresAt > now) {
        return filterEmbedBuilderSearchRecords(
            interaction.guild, interaction.member, cached.records, { requireSend: true },
        );
    }

    const known = peekEmbedRegistry(guildId);
    const canonicalRecords = peekCanonicalBuilderRecords(interaction.guild);
    const raw = mergeSearchRecords(guildId, [...(known || []), ...canonicalRecords]);
    if (raw.length) {
        // Store unfiltered records to avoid one member's permission set hiding
        // results from another. Check each requesting user's access on return.
        fastSearchCache.set(guildId, {
            generation,
            registryPending: !known,
            records: raw,
            expiresAt: now + FAST_SEARCH_CACHE_TTL,
        });
        return filterEmbedBuilderSearchRecords(
            interaction.guild, interaction.member, raw, { requireSend: true },
        );
    }

    if (cached?.generation === generation && cached?.records?.length) {
        return filterEmbedBuilderSearchRecords(
            interaction.guild, interaction.member, cached.records, { requireSend: true },
        );
    }
    return [];
}

async function loadEmbedBuilderSearchRecords(interaction) {
    await Promise.all([
        warmSystemCatalogForSearch(interaction.client),
        ensureHiddenBuilderCatalogLoaded(interaction.guildId),
    ]);
    const registryRecords = await getEmbedRegistry(interaction.guildId, { cached: true });
    await warmSavedEmbedTemplateScopes(
        interaction.guildId,
        registryRecords.map(record => record.channelId),
    );

    // Canonical records carry the same full preview/source pairing used by the
    // normal Modify browser. Keep the raw registry too so two genuinely
    // different physical/manual embeds can still be distinguished by content.
    const canonicalRecords = await getFastCanonicalBuilderRecords(interaction.guild)
        .catch(() => []);

    const merged = mergeSearchRecords(
        interaction.guildId,
        [...registryRecords, ...canonicalRecords],
    );
    return filterEmbedBuilderSearchRecords(
        interaction.guild,
        interaction.member,
        merged,
        { requireSend: true },
    );
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
        if (!existing
            || String(record?.source || '') === 'system-catalog'
            || searchRecordRichness(record) > searchRecordRichness(existing)) {
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

function componentIds(record) {
    return (record?.components || []).flatMap(row =>
        (row?.components || []).map(component => {
            const data = component?.toJSON ? component.toJSON() : component?.data || component;
            return String(data?.custom_id || data?.customId || '');
        }).filter(Boolean),
    );
}

function hasInteractiveComponents(record) {
    return componentIds(record).length > 0;
}

const STABLE_PANEL_COMPONENT_IDS = new Set([
    FAQ_AI_BUTTON_ID,
    FIX_GUIDE_ASK_BUTTON_ID,
]);

function hasStablePanelAction(record) {
    return componentIds(record).some(id => STABLE_PANEL_COMPONENT_IDS.has(id));
}

function isCanonicalLivePanelRecord(record) {
    const source = String(record?.source || '').toLowerCase();
    return ['bot-history', 'history'].includes(source)
        && hasInteractiveComponents(record)
        && (Boolean(record?.canonicalIdentity) || hasStablePanelAction(record));
}

function isTransientAssistantCatalogRecord(record) {
    if (String(record?.source || '').toLowerCase() !== 'system-catalog') return false;
    if (hasInteractiveComponents(record)) return false;

    const title = normalize(rawRecordTitle(record));
    return /^cloudy fix guide(?:\s+\d+)?$/.test(title)
        || title === 'cloudy support assistant';
}

// A removed catalog entry can also have a physical/modified registry mirror.
// Apply its persisted Builder-only visibility to those Search aliases too;
// never hide the physical Discord messages from channel history or touch
// independently authored manual Builder posts.
function isHiddenBuilderSearchAlias(record) {
    const source = String(record?.source || '').toLowerCase();
    // Independently posted manual Builder embeds are the user's own records
    // and must never disappear because a system response was hidden.
    if (source === 'embed-builder') return false;
    // A Search choice can contain a physical or modified mirror whose own
    // author metadata was stripped after Save. Its attached sourceRecord
    // still identifies the hidden catalog family; check that identity too
    // instead of resurrecting the deleted Search choice through this mirror.
    for (const candidate of [record, record?.sourceRecord, record?.previewRecord]) {
        if (!candidate) continue;
        if (isSystemCatalogHiddenFromBuilder({
            ...candidate, guildId: record.guildId || candidate.guildId,
            source: 'system-catalog',
        })) return true;
    }
    return false;
}

// A content-only bot response has no authored embed title. Its auto-generated
// "friendly" label is often the first line of its BODY (e.g. Ask Cloudy...).
// The user explicitly wants Search to contain real embed titles only.
function isUntitledCatalogContent(record) {
    if (String(record?.source || '').toLowerCase() === 'embed-builder') return false;
    const authorName = String(record?.snapshot?.author?.name
        || record?.sourceRecord?.snapshot?.author?.name || '');
    return /\|\|\s*Cloudy kind:\s*content\s*$/i.test(authorName);
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

        if (source === 'embed-builder' && record.manualSaved === false) continue;
        if (isSystemCatalogHiddenFromBuilder(record) || isHiddenBuilderSearchAlias(record)) continue;
        if (isUntitledCatalogContent(record)) continue;
        // The intermediate Pinging... acknowledgement is not another reusable
        // response type; only the final latency reply is editable in Search.
        if (source !== 'embed-builder' && /^(?:ping|pong)$/.test(normalize(recordTitle(record)))
            && /^pinging\.{0,3}$/i.test(String(snapshot(record)?.description || '').trim())) continue;
        if (['bot-history', 'history'].includes(source) && !isCanonicalLivePanelRecord(record)) continue;
        if (isTransientAssistantCatalogRecord(record)) continue;
        if (record?.detached && !['system-catalog', 'embed-builder'].includes(source)) continue;
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
    const selectedIdentity = exactAutomatedSearchIdentity(selectedRecord, selectedDocument);
    const realRecords = records
        .filter(record => String(record?.source || '').toLowerCase() !== 'system-catalog' && !record?.detached);

    const compatible = realRecords
        .filter(record => {
            const document = recordDocument(guild, record);
            const identity = exactAutomatedSearchIdentity(record, document);
            return Boolean(selectedIdentity && identity && selectedIdentity === identity)
                || compatibleSearchShape(selectedRecord, record, selectedDocument, document);
        });

    const candidates = compatible.length
        ? compatible
        : String(selectedRecord?.source || '').toLowerCase() === 'system-catalog'
            ? realRecords.filter(record =>
                logicalKey(record, recordDocument(guild, record))
                    === logicalKey(selectedRecord, selectedDocument))
            : [];

    // A catalog row may be sparse while one unique live message contains the
    // complete embed. Use that single peer. If several same-title peers exist,
    // refuse to guess which one belongs to the selected Search result.
    const safeCandidates = compatible.length || candidates.length <= 1 ? candidates : [];

    return safeCandidates
        .sort((left, right) => {
            const completeness = searchRecordCompleteness(left) - searchRecordCompleteness(right);
            if (completeness) return completeness;
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

function manualSearchIdentity(record) {
    const data = snapshot(record);
    try {
        return [
            'manual',
            JSON.stringify({
                title: normalize(data?.title),
                description: normalize(data?.description),
                fields: Array.isArray(data?.fields)
                    ? data.fields.map(field => ({
                        name: normalize(field?.name),
                        value: normalize(field?.value),
                        inline: Boolean(field?.inline),
                    }))
                    : [],
                color: Number.isInteger(data?.color) ? data.color : null,
                footer: normalize(data?.footer?.text),
                thumbnail: String(data?.thumbnail?.url || ''),
                image: String(data?.image?.url || ''),
                components: Array.isArray(record?.components) ? record.components : [],
            }),
        ].join(':');
    } catch {
        return '';
    }
}

function exactAutomatedSearchIdentity(record, document = null) {
    const source = String(record?.source || '').toLowerCase();
    if (source === 'embed-builder') return manualSearchIdentity(record);
    const ticketLog = automatedTicketLogFamily(record);
    if (ticketLog) return 'ticket-log:' + ticketLog.key;

    // Gateway/API latency changes on every /ping call. Those values must stay
    // dynamic, not create a new editable template for each invocation.
    const title = normalize(recordTitle(record));
    if (title === 'ping' || title === 'pong') {
        const data = snapshot(record);
        const fields = (Array.isArray(data?.fields) ? data.fields : [])
            .map(field => normalize(field?.name));
        if (fields.some(name => /^(?:bot|api) latency$/.test(name))
            || /\b(?:bot|api) latency\b/i.test(String(data?.description || ''))) {
            return 'command:ping:latency';
        }
    }

    // New report is one automated response family. Case numbers, free-text
    // reasons and optional evidence belong to the report instance, not to a
    // different Search template. Manual Builder posts were handled above.
    if (normalize(recordTitle(record)) === 'new report') {
        return 'report:new';
    }

    const stableContext = stableSearchTemplateContext(record);
    const sourceTitle = rawRecordTitle(record);
    const definition = getSystemSourceDefinitionPreview(
        sourceTitle,
        stableContext || searchContext(record, document),
    );
    const shape = definition
        ? visibleSearchShape(definition)
        : visibleSearchShape(snapshot(record));

    try {
        // Physical IDs, channel names and decoration do not create another
        // Search item. Only a genuinely different response shape does.
        return [
            definition ? 'definition' : 'visible',
            normalize(sourceTitle),
            JSON.stringify(shape),
        ].join(':');
    } catch {
        return '';
    }
}

function searchRecordCompleteness(record) {
    const data = snapshot(record);
    let score = 0;
    if (data?.description) score += 1000 + String(data.description).length;
    if (Array.isArray(data?.fields)) score += data.fields.length * 500;
    if (data?.footer?.text) score += 250;
    if (data?.thumbnail?.url) score += 150;
    if (data?.image?.url) score += 100;
    if (Array.isArray(record?.components)) score += record.components.length * 200;
    return score;
}

function compatibleSearchShape(leftRecord, rightRecord, leftDocument, rightDocument) {
    if (normalize(leftDocument?.title) !== normalize(rightDocument?.title)) return false;

    const leftSource = String(leftRecord?.source || '').toLowerCase();
    const rightSource = String(rightRecord?.source || '').toLowerCase();
    if (leftSource === 'embed-builder' || rightSource === 'embed-builder') return false;
    if (leftSource !== 'system-catalog' && rightSource !== 'system-catalog') return false;

    const leftContext = stableSearchTemplateContext(leftRecord);
    const rightContext = stableSearchTemplateContext(rightRecord);
    if (leftContext && rightContext && leftContext !== rightContext) return false;

    const left = visibleSearchShape(snapshot(leftRecord));
    const right = visibleSearchShape(snapshot(rightRecord));
    if (left.description && right.description && left.description !== right.description) return false;

    const fieldMap = fields => new Map((fields || [])
        .filter(field => field?.name)
        .map(field => [field.name, field.value || '']));
    const leftFields = fieldMap(left.fields);
    const rightFields = fieldMap(right.fields);
    if (leftFields.size && rightFields.size) {
        let shared = 0;
        for (const [name, value] of leftFields) {
            if (!rightFields.has(name)) continue;
            shared += 1;
            const other = rightFields.get(name);
            if (value && other && value !== other) return false;
        }
        if (!shared) return false;
    }

    return true;
}

function mergeCompatibleSearchMatch(left, right) {
    const candidates = [left.record, right.record]
        .flatMap(record => [record, record?.previewRecord, record?.sourceRecord])
        .filter(Boolean);

    const catalog = candidates
        .filter(record => String(record?.source || '').toLowerCase() === 'system-catalog')
        .sort((a, b) => searchRecordCompleteness(a) - searchRecordCompleteness(b))
        .at(-1) || null;
    const live = candidates
        .filter(record => String(record?.source || '').toLowerCase() !== 'system-catalog' && !record?.detached)
        .sort((a, b) => searchRecordCompleteness(a) - searchRecordCompleteness(b)
            || new Date(a?.createdAt || 0).getTime() - new Date(b?.createdAt || 0).getTime())
        .at(-1) || null;

    // A successfully saved title is the canonical display identity, even
    // when an older catalog record belongs to the same response family.
    // Keep the catalog attached as sourceRecord, never as the winner over Save.
    const saved = [left, right].filter(match =>
        match.record?.manualSaved === true || savedSearchSnapshot(match.record).matched
    ).sort((a, b) =>
        Number(Boolean(a.record.manualSaved)) - Number(Boolean(b.record.manualSaved))
        || new Date(a.record.updatedAt || 0) - new Date(b.record.updatedAt || 0)
    ).at(-1) || null;
    const selected = saved?.record || catalog || chooseBetter(left, right).record;
    const record = {
        ...selected,
        ...(live ? { previewRecord: live } : {}),
        ...(catalog ? { sourceRecord: catalog } : {}),
    };

    return {
        record,
        document: saved?.document || (left.score >= right.score ? left.document : right.document),
        score: Math.max(left.score ?? 0, right.score ?? 0),
    };
}

function mergeCompatibleCatalogPeers(matches) {
    const merged = [];
    const titleIndexes = new Map();
    for (const match of matches) {
        const title = normalize(match.document?.title);
        const peers = titleIndexes.get(title) || [];
        const index = peers.find(candidate => compatibleSearchShape(
            merged[candidate].record, match.record, merged[candidate].document, match.document,
        )) ?? -1;
        if (index < 0) {
            peers.push(merged.length);
            titleIndexes.set(title, peers);
            merged.push(match);
            continue;
        }
        merged[index] = mergeCompatibleSearchMatch(merged[index], match);
    }
    return merged;
}

function completeSelectedSearchRecord(guild, records, selectedRecord) {
    // Only catalog templates can have source/runtime peers. A manually saved
    // embed is its own canonical record: scanning thousands of catalog items
    // cannot improve it and risks mixing independently saved messages.
    if (String(selectedRecord?.source || '').toLowerCase() === 'embed-builder') return selectedRecord;
    let selected = {
        record: selectedRecord,
        document: recordDocument(guild, selectedRecord),
        score: 0,
    };

    for (const candidate of builderSearchDisplayRecords(records)) {
        if (candidate === selectedRecord
            || (String(candidate?.channelId) === String(selectedRecord?.channelId)
                && String(candidate?.messageId) === String(selectedRecord?.messageId)
                && Number(candidate?.embedIndex || 0) === Number(selectedRecord?.embedIndex || 0))) {
            continue;
        }
        const document = recordDocument(guild, candidate);
        if (!compatibleSearchShape(selected.record, candidate, selected.document, document)) continue;
        selected = mergeCompatibleSearchMatch(selected, { record: candidate, document, score: 0 });
    }

    return selected.record;
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

    const uniqueMatches = mergeCompatibleCatalogPeers(matches);

    return uniqueMatches.sort((a, b) => {
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

// Bound the heavy snapshot/dedup pipeline to a shortlist before Discord's
// autocomplete deadline. Full canonical records remain available on selection.
// Title and body terms are both considered, including errors whose title is
// generic but whose description names the underlying response.
export function buildAutocompleteMatches(guild, records, rawQuery) {
    // One synchronous list build consults the same snapshot repeatedly for
    // labels, grouping and ranking. Reuse that resolution only for this call;
    // the next query must see any Save immediately, even on the same record.
    const previous = autocompleteSnapshots;
    autocompleteSnapshots = new WeakMap();
    try {
        return autocompleteMatches(guild, records, rawQuery);
    } finally {
        autocompleteSnapshots = previous;
    }
}

function autocompleteMatches(guild, records, rawQuery) {
    const query = normalize(rawQuery);
    if (records.length <= 80) return buildMatches(guild, records, query).slice(0, 25);
    if (!query) {
        // Opening the list needs 25 suggestions, not full preview/peer
        // preparation for every catalog row. Expand only when filtering or
        // deduplication leaves fewer choices. Typed searches retain all rows.
        const ranked = records.map(record => ({ record, title: recordTitle(record), priority: priority(record) }))
            .filter(candidate => candidate.title)
            .sort((a, b) => b.priority - a.priority
                || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
        const shortlist = [];
        const identities = new Set();
        for (const candidate of ranked) {
            const key = stableSearchTemplateKey(candidate.record);
            const family = automatedTicketLogFamily(candidate.record);
            const identity = key ? 'template:' + key + ':' + stableSearchTemplateContext(candidate.record)
                : family ? 'ticket:' + family.key : null;
            if (identity && identities.has(identity)) continue;
            if (identity) identities.add(identity);
            shortlist.push(candidate.record);
            if (shortlist.length % 80 === 0) {
                const matches = buildMatches(guild, shortlist, '');
                if (matches.length >= 25) return matches.slice(0, 25);
            }
        }
        return buildMatches(guild, shortlist, '').slice(0, 25);
    }

    const tokens = query.split(' ').filter(Boolean);
    const candidates = [];
    for (const record of records) {
        const data = record?.snapshot || {};
        // The fast candidate shortlist must use the saved title too; otherwise
        // a renamed catalog result remains undiscoverable for the new name
        // until a canonical background index refresh.
        const saved = savedSearchSnapshot(record);
        const family = automatedTicketLogFamily(record);
        const title = normalize(family?.title || ((saved.matched || record.manualSaved) && saved.data?.title
            ? saved.data.title
            : [record?.name, record?.title, data.title].filter(Boolean).join(' ')));
        const body = normalize([
            data.description,
            ...(Array.isArray(data.fields) ? data.fields.flatMap(f => [f?.name, f?.value]) : []),
        ].filter(Boolean).join(' '));
        const combined = title + ' ' + body;
        if (!tokens.every(token => combined.includes(token))) continue;
        const rank = title === query ? 10000
            : title.startsWith(query) ? 9000
            : title.includes(query) ? 8000
            : body.includes(query) ? 3500 : 1000;
        candidates.push({ record, rank });
    }

    candidates.sort((a, b) => b.rank - a.rank);
    const shortlist = [];
    const ticketFamilies = new Set();
    for (const candidate of candidates) {
        const family = automatedTicketLogFamily(candidate.record);
        if (family) {
            if (ticketFamilies.has(family.key)) continue;
            ticketFamilies.add(family.key);
        }
        shortlist.push(candidate.record);
        if (shortlist.length === 80) break;
    }
    return buildMatches(guild, shortlist, query).slice(0, 25);
}

function cleanChoiceText(value, max = 48) {
    return clean(
        String(value || '')
            .replace(/\p{Extended_Pictographic}/gu, ' ')
            .replace(/[\uFE0F\u200D]/g, ' ')
            .replace(/<a?:[^:>]+:\d+>/g, ' ')
            .replace(/<[@#&!]?\d+>/g, ' ')
            .replace(/\{dynamic\}/gi, ' ')
            .replace(/\b(?:report|ticket|case)\s*#?\s*\d+\b/gi, match =>
                match.replace(/\s*#?\s*\d+\b/, ''))
            .replace(/\b\d{5,}\b/g, ' ')
            .replace(/[•·|]+/g, ' ')
            .replace(/[-_–—]+/g, ' ')
            .replace(/[*_`~>#]+/g, ' ')
            .replace(/\s+/g, ' '),
        max,
    );
}

const PREFERRED_DETAIL_FIELDS = new Set([
    'audience', 'action', 'status', 'result', 'type', 'reason', 'priority',
    'category', 'mode', 'method', 'source', 'target', 'role',
]);
const GENERIC_DETAIL_FIELDS = new Set([
    'report', 'ticket', 'case', 'member', 'user', 'id', 'channel', 'server',
]);
const TECHNICAL_CHANNEL_NAMES = /^(?:bot\s*log|botlog|report\s*logs?|logs?)$/i;

function searchContextLabel(record) {
    const context = stableSearchTemplateContext(record);
    if (!context) return '';
    const parts = context.split('/').map(part => part.trim()).filter(Boolean);
    let leaf = parts.at(-1) || '';
    if (/^(?:botlog|reports?|logs?)$/i.test(leaf) && parts.length > 1) leaf = parts.at(-2);
    leaf = leaf
        .replace(/-(?:service|interaction|module|handler|command)$/i, '')
        .replace(/^(?:botlog|report-?logs?)$/i, '');
    return commercialBuilderTitle(leaf);
}

function choiceDetail(match) {
    const { record, document } = match;
    const data = snapshot(record);
    const fields = Array.isArray(data?.fields) ? data.fields : [];

    // Prefer a field that explains why two same-title responses are genuinely
    // different. Report cases, for example, become Reporter / Reported member
    // instead of meaningless (2), (3), ... suffixes.
    for (const field of fields) {
        const fieldName = normalize(cleanChoiceText(field?.name, 36));
        if (!PREFERRED_DETAIL_FIELDS.has(fieldName)) continue;
        const value = commercialBuilderTitle(cleanChoiceText(field?.value, 48));
        if (value && normalize(value) !== normalize(document.title)) return value;
    }

    const description = String(data?.description || '')
        .split('\n')
        .map(line => commercialBuilderTitle(cleanChoiceText(line, 60)))
        .find(value => value && normalize(value) !== normalize(document.title));
    if (description) return description;

    for (const field of fields) {
        const fieldName = commercialBuilderTitle(cleanChoiceText(field?.name, 36));
        const normalizedName = normalize(fieldName);
        if (!fieldName || GENERIC_DETAIL_FIELDS.has(normalizedName)) continue;
        const value = commercialBuilderTitle(cleanChoiceText(field?.value, 42));
        if (value && normalize(value) !== normalize(fieldName)) {
            return clean(`${fieldName}: ${value}`, 60);
        }
        if (normalize(fieldName) !== normalize(document.title)) return fieldName;
    }

    const context = searchContextLabel(record);
    if (context && normalize(context) !== normalize(document.title)) return context;

    const channelName = cleanChoiceText(document?.channel?.name, 30);
    if (channelName && !TECHNICAL_CHANNEL_NAMES.test(channelName)) return commercialBuilderTitle(channelName);
    return '';
}

// Native autocomplete is plain text. Keep the owner's literal custom emoji
// code (or iOS shortcode); the actual embed/preview renders the saved markup.
export function humanSearchChoiceTitle(value) {
    return clean(value, 100);
}

export function buildSearchChoices(matches) {
    const list = Array.isArray(matches) ? matches : [];
    const choices = [];
    const usedNames = new Map();

    for (const { record, document } of list) {
        const resolved = savedSearchSnapshot(record);
        const explicitTitle = record?.manualSaved || resolved.matched;
        // Discord's native autocomplete menu must show the embed title ONLY.
        // No description, member, ticket, channel or preview body is part of
        // the choice label; all those details remain in the live preview.
        const title = explicitTitle
            ? humanSearchChoiceTitle(document?.title || 'Embed')
            : (commercialBuilderTitle(document?.title || 'Embed') || 'Embed');
        const key = normalize(title);
        if (!key) continue;
        const value = selectionValue(record);
        const existing = usedNames.get(key);
        const rank = Number(Boolean(record?.manualSaved)) * 2 + Number(Boolean(resolved.matched));
        if (existing) {
            if (rank > existing.rank) {
                choices[existing.index] = { name: title, value };
                usedNames.set(key, { index: existing.index, rank });
            }
            continue;
        }
        usedNames.set(key, { index: choices.length, rank });
        choices.push({ name: title, value });
    }
    // The native Discord autocomplete endpoint allows at most 25 choices;
    // inspect the full ranked shortlist first so a later saved record can
    // still replace a stale catalog name before this limit is applied.
    return choices.slice(0, 25);
}

function selectionValue(record) {
    return [record?.channelId, record?.messageId, Number(record?.embedIndex || 0)].join(':').slice(0, 100);
}

function parseSelection(value) {
    const match = String(value || '').match(/^(\d+):(\d+|draft-[a-f0-9-]+):(\d+)$/);
    if (!match) return null;
    return {
        channelId: match[1],
        messageId: match[2],
        embedIndex: Number(match[3] || 0),
    };
}

// An immediate static preview must never suppress live dynamic examples
// (bets, winners, ticket data) or a source title different from the clean
// Search label. Those continue through the existing runtime hydration path.
export function canUseImmediateCatalogPreview(record) {
    if (String(record?.source || '').toLowerCase() !== 'system-catalog'
        || (record.previewRecord && !record.previewRecord.detached
            && String(record.previewRecord.source || '').toLowerCase() !== 'system-catalog')) return false;
    const data = record.snapshot || {};
    if (!data.description && !data.fields?.length) return false;
    if (normalize(data.title) !== normalize(recordTitle(record))) return false;
    // The displayed Search identity can be cleaner than a stale catalog title.
    // A mismatch cannot safely take the static shortcut: the existing source
    // resolution remains responsible for choosing the authoritative preview.
    const offeredTitle = commercialBuilderTitle(record.name || record.title);
    if (offeredTitle && normalize(offeredTitle) !== normalize(recordTitle(record))) return false;
    const context = stableSearchTemplateContext(record);
    if (/^(?:gambling|economy|tickets|ticket-logs|ticket-transcripts|reports)(?:\/|$)/.test(context)) return false;
    const visible = [
        data.title, data.description,
        ...(Array.isArray(data.fields) ? data.fields.flatMap(field => [field?.name, field?.value]) : []),
    ].filter(Boolean).join(' ');
    return !/\{dynamic\}|<t:\d+|<@!?\d+>|<@&\d+>|<#\d+>/.test(visible);
}

// The autocomplete result is already permission-scoped and canonicalized.
// Cache only the exact choices Discord actually showed, never a whole
// unfiltered registry or another user's search results.
const recentSearchSelections = new Map();
function rememberOfferedSearchSelections(interaction, matches, choices) {
    // This is only an ephemeral click-through cache, not a durable search
    // archive. Prune expired sessions and cap distinct users to avoid retaining
    // large snapshots indefinitely on a commercial multi-server bot.
    const now = Date.now();
    for (const [key, offered] of recentSearchSelections) {
        if (offered.expiresAt <= now) recentSearchSelections.delete(key);
    }
    const offeredValues = new Set(choices.map(choice => choice.value));
    const offeredRecords = new Map();
    for (const match of matches) {
        const value = selectionValue(match.record);
        if (offeredValues.has(value)) offeredRecords.set(value, match.record);
    }
    const cacheKey = selectionKey(interaction);
    const generation = getEmbedRegistryGeneration(interaction.guildId);
    const previous = recentSearchSelections.get(cacheKey);
    // Discord may deliver overlapping autocomplete requests out of order.
    // Keep every recently offered (permission-scoped) choice until clicked:
    // replacing the entire map on each keystroke made selections miss this
    // fast path and redo the 1-3 second catalog/runtime lookup.
    const offered = previous?.generation === generation && previous.expiresAt > now
        ? new Map(previous.records) : new Map();
    for (const [value, record] of offeredRecords) {
        offered.delete(value);
        offered.set(value, record);
    }
    while (offered.size > 125) offered.delete(offered.keys().next().value);
    recentSearchSelections.delete(cacheKey);
    recentSearchSelections.set(cacheKey, {
        generation,
        expiresAt: now + 90_000,
        records: offered,
    });
    while (recentSearchSelections.size > 250) {
        recentSearchSelections.delete(recentSearchSelections.keys().next().value);
    }
}

// Only the slow selection preparation needs a defer. Warm selections retain
// the direct first paint; cold storage/Discord reads cannot expire the callback.
export async function withBuilderSelectionAcknowledgement(interaction, prepare, delayMs = 600) {
    // The central router has already acknowledged a selected Search command.
    // Never start a competing acknowledgement timer while loading its preview.
    if (interaction.deferred || interaction.replied) return prepare();
    let acknowledgement = null;
    const timer = setTimeout(() => {
        if (!interaction.deferred && !interaction.replied && interaction.deferReply) {
            acknowledgement = interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => null);
        }
    }, delayMs);
    try {
        return await prepare();
    } finally {
        clearTimeout(timer);
        if (acknowledgement) await acknowledgement;
    }
}

export async function loadEmbedBuilderSearchSelection(interaction) {
    const selected = parseSelection(interaction.options?.getString?.('search') || '');
    if (!selected || !interaction.guildId) return null;
    // A stale Discord suggestion clicked during Delete cannot reopen it.
    if (isSearchDeleteHidden({
        guildId: interaction.guildId,
        ...selected,
    })) return null;
    const markSelection = createBuilderPerformanceTracker('search_selection');
    // Discord already received the exact, canonical Search record during
    // autocomplete. Reuse it for the same user and registry generation instead
    // of scanning and merging the entire catalog again after their click.
    // Access is revalidated at selection time; a Save/Delete invalidates this
    // snapshot through the registry generation guard.
    const offered = recentSearchSelections.get(selectionKey(interaction));
    const selectedValue = [selected.channelId, selected.messageId, selected.embedIndex].join(':');
    let record = null;
    let records = [];
    if (offered?.expiresAt > Date.now()) {
        let candidate = offered.records.get(selectedValue);
        if (candidate && offered.generation !== getEmbedRegistryGeneration(interaction.guildId)) {
            // New bot logs/registry registrations can advance the generation
            // while the user selects an option just offered by autocomplete.
            // Verify this exact record still exists in the hot registry/catalog
            // before reusing it; explicit Save/Delete also clear offered maps.
            const latest = peekEmbedRegistry(interaction.guildId, { current: true })
                ?.find(item => String(item.channelId) === selected.channelId
                    && String(item.messageId) === selected.messageId
                    && Number(item.embedIndex || 0) === selected.embedIndex);
            if (latest) {
                candidate = { ...candidate, ...latest,
                    previewRecord: candidate.previewRecord || latest.previewRecord,
                    sourceRecord: candidate.sourceRecord || latest.sourceRecord };
            } else if (String(candidate.source || '').toLowerCase() === 'system-catalog') {
                const exists = getSearchableSystemCatalogRecords(interaction.guildId).some(item =>
                    String(item.channelId) === selected.channelId
                    && String(item.messageId) === selected.messageId
                    && Number(item.embedIndex || 0) === selected.embedIndex);
                if (!exists) candidate = null;
            } else {
                candidate = null;
            }
        }
        record = candidate
            ? sanitizeSearchRecordAccess(interaction.guild, interaction.member, candidate, { requireSend: true })
            : null;
        if (record) records = [record, record.previewRecord, record.sourceRecord].filter(Boolean);
    }
    const fromAutocomplete = Boolean(record);
    if (!record) {
        const findSelected = items => {
            const candidate = items.find(item =>
                String(item.channelId) === selected.channelId
                && String(item.messageId) === selected.messageId
                && Number(item.embedIndex || 0) === selected.embedIndex
            );
            return candidate ? builderSearchDisplayRecords([candidate])[0] || null : null;
        };
        // A cold or expired selection retains the complete original resolution
        // path. No saved record or Source/Save pairing is discarded.
        records = await loadFastEmbedBuilderSearchRecords(interaction);
        let selectedRecord = findSelected(records);
        if (!selectedRecord) {
            const freshRegistry = await getEmbedRegistry(interaction.guildId, { cached: true })
                .catch(() => []);
            records = mergeSearchRecords(interaction.guildId, freshRegistry);
            selectedRecord = findSelected(records);
        }
        if (!selectedRecord) {
            records = await loadEmbedBuilderSearchRecords(interaction);
            selectedRecord = findSelected(records);
        }
        if (!selectedRecord || isSearchDeleteHidden(selectedRecord)) return null;
        record = completeSelectedSearchRecord(interaction.guild, records, selectedRecord);
    }
    if (isSearchDeleteHidden(record)) return null;
    markSelection('record_ready');
    const savedManualSnapshot = record.source === 'embed-builder'
        && record.manualSaved === true && record.snapshot
        && Array.isArray(record.components);
    // Complete manual Saves need no catalog peer scan, but their saved family
    // overlays are still authoritative. Never guess those from a cold cache.
    // When no live peer can exist, runtime fallback data is independent of the
    // overlay read and can load concurrently without changing peer selection.
    const previewSource = String(record.previewRecord?.source || '').toLowerCase();
    const independentRuntime = savedManualSnapshot || (
        (!record.previewRecord || record.previewRecord.detached || previewSource === 'system-catalog')
        && records.every(candidate => candidate.detached
            || String(candidate.source || '').toLowerCase() === 'system-catalog')
    );
    // A complete source snapshot offered by autocomplete is already a valid
    // preview. Do not block its first paint on a legacy runtime-example DB
    // lookup that can take over a second. Manual Saves and live peers still
    // follow their existing authoritative preview paths.
    const readyCatalogSnapshot = fromAutocomplete && canUseImmediateCatalogPreview(record);
    // A catalog source already contains the complete Preview that Search
    // offered. The legacy runtime-example DB may stall for multiple seconds.
    // Use it only when there is no complete offered snapshot or an explicitly
    // live preview; otherwise first paint stays local and deterministic.
    const offeredSnapshot = Boolean(fromAutocomplete && (record.snapshot?.description
        || record.snapshot?.fields?.length));
    const directPreview = offeredSnapshot && !record.previewRecord
        && String(record.source || '').toLowerCase() === 'system-catalog'
        && !/^(?:economy leaderboard|economy dashboard)$/i.test(
            String(record.snapshot?.title || '').trim())
        && !/^(?:gambling|economy|tickets|ticket-logs|ticket-transcripts|reports)(?:\/|$)/
            .test(stableSearchTemplateContext(record))
        && !/\{dynamic\}|<t:\d+|<@!?\d+>|<@&\d+>|<#\d+>/
            .test(JSON.stringify(record.snapshot || {}));
    // Autocomplete already delivered this complete, permission-checked live
    // snapshot to the same user. Don't repeat the runtime DB lookup and a
    // 650ms Discord REST fetch just to paint the read-only editor preview.
    // On Save the physical message is still verified by saveModifiedEmbed.
    const offeredLive = record.previewRecord
        && !record.previewRecord.detached
        && String(record.previewRecord.source || '').toLowerCase() !== 'system-catalog'
        ? record.previewRecord : null;
    const quickLive = offeredLive || (
        String(record.source || '').toLowerCase() !== 'system-catalog' ? record : null
    );
    const readyLiveSnapshot = Boolean(fromAutocomplete && quickLive?.snapshot
        && (quickLive.snapshot.description || quickLive.snapshot.fields?.length)
        && (quickLive.snapshot.title || quickLive.title || quickLive.name)
        && !quickLive.detached);
    const runtimePreparation = savedManualSnapshot
        ? Promise.resolve(record)
        : readyLiveSnapshot
        ? Promise.resolve(quickLive)
        : directPreview || readyCatalogSnapshot
            ? Promise.resolve(record)
            : independentRuntime
                ? hydrateBuilderPreviewRecord(
                    interaction.guild, record, savedManualSnapshot ? record : record.previewRecord || null, interaction.user.id,
                ).catch(() => null)
                : null;
    await warmSavedEmbedTemplateScopes(interaction.guildId, [
        record.channelId, record.previewRecord?.channelId, record.sourceRecord?.channelId,
    ]);
    markSelection('templates_ready');
    // Peer matching consults saved overlays, so keep it after authoritative warming.
    const groupedPreview = savedManualSnapshot ? record : (record.previewRecord
        || latestRealPreviewRecord(interaction.guild, records, record)
        || (String(record.source || '').toLowerCase() !== 'system-catalog' ? record : null));
    const runtimePreview = runtimePreparation
        ? await runtimePreparation || groupedPreview
        : await hydrateBuilderPreviewRecord(
            interaction.guild, record, groupedPreview, interaction.user.id,
        ).catch(() => groupedPreview);
    // An explicit Save already holds the authoritative full snapshot and
    // component rows. Do not wait up to 650ms for a redundant Discord fetch
    // before its Builder preview becomes visible; normal live records still
    // validate/fetch as before.
    const previewRecord = savedManualSnapshot || directPreview
        ? record
        : readyLiveSnapshot ? quickLive
        : (runtimePreview
            ? await hydrateLiveSearchRecord(interaction.guild, runtimePreview)
            : null);
    // Manual Builder controls are loaded from the selected record. If the live
    // read found newer buttons on that exact message, keep them in the draft.
    if (record.source === 'embed-builder' && previewRecord
        && String(previewRecord.messageId) === String(record.messageId)
        && String(previewRecord.backingChannelId || previewRecord.channelId)
            === String(record.backingChannelId || record.channelId)
        && Number(previewRecord.embedIndex || 0) === Number(record.embedIndex || 0)
        && Array.isArray(previewRecord.components)) {
        record = { ...record, components: previewRecord.components };
    }
    markSelection('preview_ready');
    return {
        record,
        previewRecord,
        previewTitle: recordTitle(record),
        sourceRecord: record.sourceRecord || null,
        expiresAt: Date.now() + PENDING_TTL,
    };
}

export async function hydrateLiveSearchRecord(guild, record, timeoutMs = 650) {
    if (!guild || !record || record.detached || String(record.source || '').toLowerCase() === 'system-catalog') {
        return record;
    }

    let timer;
    const resolved = await Promise.race([
        resolveEmbedRegistryRecord(guild, record).catch(() => null),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
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
    const source = String(record?.source || '').toLowerCase();
    const description = record?.detached
        ? 'Saved embed. Original message is missing'
        : source === 'embed-builder'
            ? 'Saved embed'
            : 'Cloudy response';

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
        const started = performance.now();
        const markAutocomplete = createBuilderPerformanceTracker('search_autocomplete');
        let count = 0;
        try {
            if (!interaction.guildId || !interaction.guild) {
                await interaction.respond([]);
                return;
            }
            const focused = interaction.options.getFocused(true);
            if (focused?.name !== 'search') {
                await interaction.respond([]);
                return;
            }

            const records = await loadFastEmbedBuilderSearchRecords(interaction);
            const matches = buildAutocompleteMatches(interaction.guild, records, focused.value);
            const choices = buildSearchChoices(matches);
            rememberOfferedSearchSelections(interaction, matches, choices);
            count = choices.length;
            markAutocomplete('results_ready');
            await interaction.respond(choices);
            markAutocomplete('first_visible');
        } catch (error) {
            // Previous handler silently swallowed failed Discord responses,
            // which made actual timeouts indistinguishable from "no embeds".
            logger.error('[EMBED_SEARCH] Autocomplete failed:', {
                guildId: interaction.guildId, elapsedMs: Math.round(performance.now() - started),
                error: error?.message || String(error),
            });
            if (!interaction.responded) {
                await interaction.respond([]).catch(() => {});
            }
        } finally {
            const elapsedMs = Math.round(performance.now() - started);
            if (elapsedMs > 700 || count === 0) {
                logger.warn('[EMBED_SEARCH] autocomplete telemetry', {
                    guildId: interaction.guildId, elapsedMs, resultCount: count,
                });
            }
            if (interaction.guild) scheduleAutocompleteSearchRefresh(interaction);
        }
    };

    const originalExecute = embedBuilderCommand.execute.bind(embedBuilderCommand);
    embedBuilderCommand.execute = async function executeWithLiveSearch(interaction, ...args) {
        removeExpiredSelections();
        const initialSelection = await withBuilderSelectionAcknowledgement(
            interaction, () => loadEmbedBuilderSearchSelection(interaction),
        );
        if (initialSelection) {
            pendingSelections.set(selectionKey(interaction), initialSelection);
            // BUILDER_SEARCH_EDITOR_STATE_V2: load before the editor starts.
            interaction.__cloudyInitialBuilderSelection = initialSelection;
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
