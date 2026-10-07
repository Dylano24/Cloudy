// CLOUDY_INTERACTION_LATENCY_V1
// BUILDER_SAVED_PARITY_V1
import {
    BALANCE_RESPONSE_KEY,
    balanceResponseIdentity,
    isLegacyBalanceParserArtifact } from './balanceResponseIdentity.js';
import { normalizeManualIndent } from '../utils/manualEmbedIndent.js';
import { isBuilderSessionMessage, linkBuilderSessionMessages, registerBuilderSessionCollector, touchBuilderSessionMessage } from '../utils/builderSessionCleanup.js';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    } from 'discord.js';
import { getColor } from '../config/bot.js';
import { logger } from '../utils/logger.js';
import {
    DISCORD_EMBED_TOTAL_TEXT_LIMIT,
    getEmbedsTextLength,
    } from '../utils/discordEmbedLimits.js';
import {
    getEmbedRegistry,
    getEmbedRegistryGeneration,
    getEmbedRegistrySnapshot,
    reconcileEmbedRegistry,
    updateDetachedEmbedRegistrySnapshot,
    registerCloudyEmbedMessage,
    resolveEmbedRegistryRecord,
    scanGuildForCloudyEmbeds,
    } from './embedRegistryService.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from './cloudyBrandingService.js';
import {
    CLOUDY_LOGO_URL,
    isCloudyLogoUrl,
    migrateCloudyLogoEmbedData,
    } from './cloudyLogoService.js';
import { saveEmbedTemplateDecoration,
    warmSavedEmbedTemplateScopes,
    getCachedSavedEmbedTemplateData } from './embedTemplateService.js';
import { removeRetiredGamblingGuideCommand,
    isRetiredGamblingEmbed } from '../config/gamblingCommands.js';
import { hydrateBuilderPreviewRecord } from './builderRuntimePreviewService.js';
import { discoverMissingChannelEmbed,
    discoverMissingChannelEmbeds,
    discoverRecentChannelEmbeds } from './embedMissingChannelService.js';
import { discardPendingEmbedEditorUpdates } from './embedColorPickerSessionService.js';
import {
    getBuilderMessageComponents,
    hydrateBuilderMessageComponents,
    loadBuilderComponentsFromMessage,
    loadBuilderComponentsFromRecord,
} from './embedBuilderButtonEditorService.js';
import {
    getSystemSourceDefinitionPreview,
    getSystemSourceDefinitionPreviewForEmbed,
    primeSystemEmbedCatalogMessage,
    primeSystemEmbedTemplateData,
    syncSystemEmbedCatalogMessage,
} from './systemEmbedCatalogService.js';

const PAGE_SIZE = 25;
const MANAGER_IDLE_TIMEOUT = 5 * 60_000;
const HISTORY_SCAN_TTL = 60 * 60_000;
const CLOSED_MANAGER_ERROR_CODES = new Set([10008, 10062, 50027]);
const OVERVIEW_DISCOVERY_CONCURRENCY = 3;
const historyScanTimes = new Map();
const historyScanJobs = new Map();
const activeEmbedManagerSaves = new Set();
const TEMPLATE_CHANNEL_IDS = new Set([
    '1539375620885323826',
    '1539371111240831078',
    '1539259457404412036',
    '1539372511089926244',
    '1539371572442435646',
]);

const TEMPLATE_RULES = new Map([
    ['1539375620885323826', [
        { key: 'kick-log', label: 'Kick log', match: /\bkick\s+log\b/i },
    ]],
    ['1539371111240831078', [
        { key: 'untimeout-log', label: 'Untimeout log', match: /\bun[-\s]?time[-\s]?out\s+log\b|\buntimeout\s+log\b/i },
        { key: 'timeout-log', label: 'Timeout log', match: /\btime[-\s]?out\s+log\b|\btimeout\s+log\b/i },
    ]],
    ['1539259457404412036', [
        { key: 'unban-log', label: 'Unban log', match: /\bunban\s+log\b/i },
        { key: 'ban-log', label: 'Ban log', match: /\bban\s+log\b/i },
    ]],
    ['1539372511089926244', [
        { key: 'report-log', label: 'Report log', match: /\breport(?:s)?\s+log\b|\breport\b/i },
    ]],
    ['1539371572442435646', [
        { key: 'invite-created', label: 'Invite created', match: /\binvite\s+created\b/i },
        { key: 'member-joined-using-invite', label: 'Member joined using invite', match: /\bmember\s+joined\s+using\s+invite\b/i },
    ]],
]);

const GLOBAL_TEMPLATE_RULES = [
    { key: 'welcome-cloudy', label: 'Welcome to Cloudy Inc.', match: /^welcome to cloudy(?:\s+inc\.?)?$/i },
];

export function isEmbedManagerSaveInProgress(messageId) {
    return activeEmbedManagerSaves.has(String(messageId || ''));
}

function cleanFooter(text) {
    const value = String(text || '');
    return value.endsWith(MESSAGE_BUILDER_FOOTER_MARKER)
        ? value.slice(0, -MESSAGE_BUILDER_FOOTER_MARKER.length)
        : value;
}

function shortLabel(value, fallback = 'Embed') {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return (text || fallback).slice(0, 100);
}

function recordName(record) {
    return String(record?.name || record?.title || '').replace(/\s+/g, ' ').trim();
}

function stripCustomEmojiMarkup(value) {
    return String(value || '')
        .replace(/<a?:[^:>]+:\d+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getChannelTemplateRule(channelId, value) {
    const rules = TEMPLATE_RULES.get(String(channelId)) || [];
    const cleaned = stripCustomEmojiMarkup(value);
    return rules.find(rule => rule.match.test(cleaned)) || null;
}

function getTemplateRule(channelId, value) {
    const cleaned = stripCustomEmojiMarkup(value);
    return getChannelTemplateRule(channelId, cleaned)
        || GLOBAL_TEMPLATE_RULES.find(rule => rule.match.test(cleaned))
        || null;
}

function getTemplateRuleByKey(channelId, key) {
    const rules = [
        ...(TEMPLATE_RULES.get(String(channelId)) || []),
        ...GLOBAL_TEMPLATE_RULES,
    ];
    return rules.find(rule => rule.key === key) || null;
}

function dynamicTemplateText(value) {
    return stripCustomEmojiMarkup(value)
        .replace(/\{dynamic\}/gi, '{dynamic}')
        .replace(/<t:\d+(?::[tTdDfFR])?>|<@!?\d+>|<@&\d+>|<#\d+>|<a?:[^:>]+:\d+>|https?:\/\/\S+|\$[\d,.]+|\b\d{1,3}(?:\.\d+)?%\b|\b\d{17,20}\b|\b\d+(?:\.\d+)?\b/gi, '{dynamic}')
        // A Discord tag in a title is a live value, not a different embed type.
        .replace(/@[a-z0-9_.-]{2,32}(?:#\d{4})?/gi, '{dynamic}')
        .replace(/\b[a-z0-9_.-]{2,32}'s\b/gi, "{dynamic}'s")
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

export function canonicalBuilderResponseTitle(value) {
    return dynamicTemplateText(value)
        .replace(/^currency added$/, 'add currency')
        .replace(/^currency removed$/, 'remove currency')
        .replace(/^[\s\p{Extended_Pictographic}\p{S}\p{P}]+/gu, '')
        .replace(/[\s\p{Extended_Pictographic}\p{S}\p{P}]+$/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function recordEmbedData(record) {
    const original = migrateCloudyLogoEmbedData(record?.snapshot || getEmbedRegistrySnapshot(record) || {}).data || {};
    const snapshot = getCachedSavedEmbedTemplateData(record?.guildId, record?.channelId, original).data;
    return {
        ...snapshot,
        title: snapshot.title || record?.title || record?.name || '',
        fields: Array.isArray(snapshot.fields) ? snapshot.fields : [],
    };
}

function stableSystemTemplateKey(value) {
    const data = value && typeof value === 'object' ? value : {};
    const authorName = String(data.author?.name || '').trim();
    const prefix = 'cloudy template key:';
    if (!authorName.toLowerCase().startsWith(prefix)) return '';

    return authorName
        .slice(prefix.length)
        .split(/\s+\|\|\s+cloudy\s+(?:context|kind):/i)[0]
        .trim()
        .toLowerCase();
}

function stableSystemTemplateContext(value) {
    const data = value && typeof value === 'object' ? value : {};
    const authorName = String(data.author?.name || '').trim();
    const prefix = 'cloudy template key:';
    if (!authorName.toLowerCase().startsWith(prefix)) return '';

    const match = authorName.match(/\|\|\s*Cloudy context:\s*([^|]+)/i);
    return String(match?.[1] || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function stableSystemTemplateKind(value) {
    const data = value && typeof value === 'object' ? value : {};
    const authorName = String(data.author?.name || '').trim();
    if (!authorName.toLowerCase().startsWith('cloudy template key:')) return 'embed';
    const match = authorName.match(/\|\|\s*Cloudy kind:\s*([^|]+)/i);
    const kind = String(match?.[1] || 'embed').replace(/\s+/g, ' ').trim().toLowerCase();
    return kind === 'content' ? 'content' : 'embed';
}

// CONTENT_TEMPLATE_EDITOR_V1: a plain response has a management name, not a Discord embed title.
function curatedGameTemplateContext(templateKey) {
    const match = String(templateKey || '').match(/^game:(blackjack|baccarat|roulette):/i);
    return match ? `gambling/${match[1].toLowerCase()}` : '';
}

export function prefersCatalogPreview(records) {
    // RESPONSE_EMBED_SOURCE_ALIAS_PREVIEW_V1
    // A real Discord response is the most complete preview. The hidden catalog
    // remains the reusable Save source, but it must not replace a full live
    // response with a sparse title-only card when both are available.
    const realRecords = records.filter(record => String(record?.source || '') !== 'system-catalog');
    if (realRecords.length) return false;

    const catalogRecords = records.filter(record => String(record?.source || '') === 'system-catalog');
    if (catalogRecords.length > 1) return true;

    return catalogRecords.some(record => {
        const context = stableSystemTemplateContext(getEmbedRegistrySnapshot(record));
        return /^(?:gambling|tickets)(?:\/|$)/.test(context);
    });
}

function standardDynamicTemplateName(value) {
    const title = String(value || '').replace(/\s+/g, ' ').trim();
    const possessive = title.match(/^(?:\{dynamic\}|[a-z0-9_.-]{2,32})'s\s+(.+)$/i);
    if (possessive?.[1]) return possessive[1].slice(0, 100);
    if (/^currency added$/i.test(title)) return 'Add currency';
    if (/^currency removed$/i.test(title)) return 'Remove currency';
    if (/^blackjack\s*[—-]\s*bet\b/i.test(title)) return 'Blackjack — Bet';
    if (/^baccarat\s*[—-]\s*bet\b/i.test(title)) return 'Baccarat — Bet';
    return title;
}

function normalizedTicketLogTitle(value) {
    return String(value || '')
        .replace(/<a?:[^:>]+:\d+>/g, ' ')
        .replace(/[^a-z0-9\s-]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function ticketLogFieldNames(value) {
    const data = value && typeof value === 'object' ? value : {};
    return new Set((Array.isArray(data.fields) ? data.fields : [])
        .map(field => String(field?.name || '')
            .replace(/<a?:[^:>]+:\d+>/g, ' ')
            .replace(/[^a-z0-9&\s-]/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase())
        .filter(Boolean));
}

function canonicalTicketLogTemplate(value) {
    const data = value && typeof value === 'object' ? value : {};
    const fields = ticketLogFieldNames(data);
    const title = normalizedTicketLogTitle(data.title);
    if (!fields.has('ticket') && !/\b(?:ticket|transcript|feedback|priority)\b/.test(title)) return null;

    const fieldDefinitions = [
        ['unclaim', 'Ticket unclaimed', ['unclaimed by']],
        ['claim', 'Ticket claimed', ['claimed by']],
        ['close', 'Ticket closed', ['closed by']],
        ['delete', 'Ticket deleted', ['deleted by']],
        ['unpin', 'Ticket unpinned', ['unpinned by']],
        ['pin', 'Ticket pinned', ['pinned by']],
        ['priority', 'Priority updated', ['priority']],
        ['feedback', 'Feedback received', ['rating']],
    ];
    for (const [key, label, names] of fieldDefinitions) {
        if (names.some(name => fields.has(name))) return { key, label };
    }

    if (fields.has('creator') && fields.has('messages')) return { key: 'transcript', label: 'Transcript generated' };
    if (fields.has('creator') && (fields.has('channel') || /\b(?:created|opened|open)\b/.test(title))) {
        return { key: 'open', label: 'Ticket created' };
    }

    const titleDefinitions = [
        ['reopen', 'Ticket reopened', /\breopen(?:ed)?\b/],
        ['unclaim', 'Ticket unclaimed', /\bunclaim(?:ed)?\b|\bunclaimed\b/],
        ['claim', 'Ticket claimed', /\bclaim(?:ed)?\b/],
        ['close', 'Ticket closed', /\bclos(?:e|ed)\b/],
        ['delete', 'Ticket deleted', /\bdelet(?:e|ed)\b/],
        ['unpin', 'Ticket unpinned', /\bunpin(?:ned)?\b/],
        ['pin', 'Ticket pinned', /\bpin(?:ned)?\b/],
        ['priority', 'Priority updated', /\bpriority\b/],
        ['transcript', 'Transcript generated', /\btranscript\b/],
        ['feedback', 'Feedback received', /\bfeedback\b|\brating\b/],
        ['open', 'Ticket created', /\bcreat(?:e|ed)\b|\bopen(?:ed)?\b/],
    ];
    for (const [key, label, match] of titleDefinitions) {
        if (match.test(title)) return { key, label };
    }

    return null;
}

function isLegacyTicketLog(value) {
    const data = value && typeof value === 'object' ? value : {};
    const fields = ticketLogFieldNames(data);
    const title = normalizedTicketLogTitle(data.title);
    if (!fields.has('ticket')) return false;
    return /\b(?:ticket|transcript|feedback|priority)\b/.test(title)
        || ['creator', 'claimed by', 'unclaimed by', 'closed by', 'deleted by', 'pinned by', 'unpinned by', 'priority', 'messages', 'rating']
            .some(name => fields.has(name));
}

function strictTicketLogTemplate(value) {
    const data = value && typeof value === 'object' ? value : {};
    const fields = ticketLogFieldNames(data);
    const title = normalizedTicketLogTitle(data.title);

    // Prefer structural fields whenever the snapshot is already warm.
    if (fields.has('ticket')) {
        if (fields.has('unclaimed by')) return { key: 'unclaim', label: 'Ticket unclaimed' };
        if (fields.has('claimed by')) return { key: 'claim', label: 'Ticket claimed' };
        if (fields.has('closed by')) return { key: 'close', label: 'Ticket closed' };
        if (fields.has('deleted by')) return { key: 'delete', label: 'Ticket deleted' };
        if (fields.has('unpinned by')) return { key: 'unpin', label: 'Ticket unpinned' };
        if (fields.has('pinned by')) return { key: 'pin', label: 'Ticket pinned' };
        if (fields.has('rating')) return { key: 'feedback', label: 'Feedback received' };
        if (fields.has('priority')) return { key: 'priority', label: 'Priority updated' };
        if (fields.has('creator') && fields.has('messages')) return { key: 'transcript', label: 'Transcript generated' };
        if (fields.has('creator') && fields.has('channel')) return { key: 'open', label: 'Ticket created' };
    }

    // Registry rows survive restarts while the in-memory snapshot cache does
    // not. Exact canonical event titles are therefore an equally safe fallback
    // for the first paint. No generic "ticket" matching is allowed here.
    const exact = new Map([
        ['ticket created', { key: 'open', label: 'Ticket created' }],
        ['ticket claimed', { key: 'claim', label: 'Ticket claimed' }],
        ['ticket unclaimed', { key: 'unclaim', label: 'Ticket unclaimed' }],
        ['ticket closed', { key: 'close', label: 'Ticket closed' }],
        ['ticket deleted', { key: 'delete', label: 'Ticket deleted' }],
        ['ticket pinned', { key: 'pin', label: 'Ticket pinned' }],
        ['ticket unpinned', { key: 'unpin', label: 'Ticket unpinned' }],
        ['priority updated', { key: 'priority', label: 'Priority updated' }],
        ['transcript generated', { key: 'transcript', label: 'Transcript generated' }],
        ['feedback received', { key: 'feedback', label: 'Feedback received' }],
    ]);
    return exact.get(title) || null;
}

function isTicketLogsBuilderChannel(guild, channelId) {
    const channel = guild?.channels?.cache?.get?.(String(channelId)) || null;
    const name = normalizedTicketLogTitle(channel?.name || '');
    return /^ticket(?:-|\s)*logs?$/.test(name);
}

function builderRecordsForChannel(guild, channelId, records) {
    const list = Array.isArray(records) ? records : [];
    if (!isTicketLogsBuilderChannel(guild, channelId)) return list;
    return list.filter(record => Boolean(strictTicketLogTemplate(recordEmbedData(record))));
}


function customEmojiOption(value) {
    const match = String(value || '').match(/<(a?):([^:>]+):(\d+)>/);
    if (!match) return null;
    return { id: match[3], name: match[2], animated: match[1] === 'a' };
}

function canonicalCasinoBuilderTemplate(value) {
    const data = value && typeof value === 'object' ? value : {};
    const stableKey = stableSystemTemplateKey(data);
    const stableLabels = new Map([
        ['game:roulette:won', 'Roulette win'],
        ['game:roulette:lost', 'Roulette loss'],
        ['game:blackjack:bet', 'Blackjack bet'],
        ['game:blackjack:result:bust', 'Blackjack bust'],
        ['game:blackjack:result:blackjack', 'Blackjack natural win'],
        ['game:blackjack:result:win', 'Blackjack win'],
        ['game:blackjack:result:push', 'Blackjack push'],
        ['game:blackjack:result:loss', 'Blackjack loss'],
        ['game:blackjack:result:expired', 'Blackjack expired'],
        ['game:baccarat:bet', 'Baccarat bet'],
        ['game:baccarat:win', 'Baccarat win'],
        ['game:baccarat:loss', 'Baccarat loss'],
        ['game:baccarat:tie', 'Baccarat tie'],
        ['game:baccarat:push', 'Baccarat push'],
        ['game:baccarat:expired', 'Baccarat expired'],
    ]);
    if (stableLabels.has(stableKey)) return { key: stableKey, label: stableLabels.get(stableKey) };

    const title = stripCustomEmojiMarkup(data.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const description = stripCustomEmojiMarkup(data.description || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const fields = new Set((Array.isArray(data.fields) ? data.fields : [])
        .map(field => stripCustomEmojiMarkup(field?.name || '').replace(/\s+/g, ' ').trim().toLowerCase())
        .filter(Boolean));
    const context = stableSystemTemplateContext(data);

    let game = context.match(/^gambling\/(blackjack|baccarat|roulette)$/)?.[1] || '';
    if (!game) {
        if (/^result\s*:\s*(?:bust|blackjack|win|push|loss|expired)$/.test(title)) game = 'blackjack';
        else if (/\bblackjack\b/.test(title) || (fields.has('your hand') && fields.has('dealer hand'))) game = 'blackjack';
        else if (/\bbaccarat\b/.test(title) || (fields.has('player hand') && fields.has('banker hand'))) game = 'baccarat';
        else if (/\broulette\b|wheel landed/.test(`${title} ${description}`) || (fields.has('your bet') && fields.has('result'))) game = 'roulette';
    }
    if (!game) return null;

    const signal = `${title} ${description}`;
    if (game === 'roulette') {
        if (/\b(?:loss|lost)\b/.test(signal)) return { key: 'game:roulette:lost', label: 'Roulette loss' };
        if (/\b(?:win|won)\b/.test(signal)) return { key: 'game:roulette:won', label: 'Roulette win' };
        return null;
    }

    if (game === 'blackjack') {
        if (/\bbet\b/.test(title)) return { key: 'game:blackjack:bet', label: 'Blackjack bet' };
        if (/\bexpired\b/.test(signal)) return { key: 'game:blackjack:result:expired', label: 'Blackjack expired' };
        if (/\bbust\b/.test(signal)) return { key: 'game:blackjack:result:bust', label: 'Blackjack bust' };
        if (/\b(?:natural|blackjack)\s+win\b|\bnatural\b/.test(signal)) return { key: 'game:blackjack:result:blackjack', label: 'Blackjack natural win' };
        if (/\b(?:push|tie)\b/.test(signal)) return { key: 'game:blackjack:result:push', label: 'Blackjack push' };
        if (/\b(?:loss|lost)\b/.test(signal)) return { key: 'game:blackjack:result:loss', label: 'Blackjack loss' };
        if (/\b(?:win|won)\b/.test(signal)) return { key: 'game:blackjack:result:win', label: 'Blackjack win' };
        return null;
    }

    if (/\bbet\b/.test(title)) return { key: 'game:baccarat:bet', label: 'Baccarat bet' };
    if (/\bexpired\b/.test(signal)) return { key: 'game:baccarat:expired', label: 'Baccarat expired' };
    if (/\b(?:tie|push)\b/.test(signal)) return { key: 'game:baccarat:push', label: 'Baccarat push' };
    if (/\b(?:loss|lost)\b/.test(signal)) return { key: 'game:baccarat:loss', label: 'Baccarat loss' };
    if (/\b(?:win|won)\b/.test(signal)) return { key: 'game:baccarat:win', label: 'Baccarat win' };
    return null;
}


function isTechnicalBuilderLabel(value) {
    const text = stripCustomEmojiMarkup(value).trim();
    return /^cloudy template key:/i.test(text)
        || /^(?:source|embed|embed-type):[a-z0-9_-]{6,}$/i.test(text)
        || /^(?:game|ticket-log):[a-z0-9:_-]+$/i.test(text);
}

function humanTemplateRecordName(record) {
    const data = recordEmbedData(record);
    const candidates = [
        data.title,
        record?.name,
        record?.title,
    ].map(value => stripCustomEmojiMarkup(value)).filter(Boolean);

    for (const candidate of candidates) {
        if (!isTechnicalBuilderLabel(candidate)) return standardDynamicTemplateName(candidate);
    }

    const firstLine = String(data.description || '')
        .split('\n')
        .map(line => stripCustomEmojiMarkup(line).replace(/^[>\s#*_`~|]+/, '').replace(/[*_`~]/g, '').trim())
        .find(Boolean);
    if (firstLine && !isTechnicalBuilderLabel(firstLine)) return firstLine;

    const firstFieldName = (data.fields || [])
        .map(field => stripCustomEmojiMarkup(field?.name || '').trim())
        .find(value => value && !isTechnicalBuilderLabel(value));
    if (firstFieldName) return standardDynamicTemplateName(firstFieldName);

    const footerText = stripCustomEmojiMarkup(data.footer?.text || '').trim();
    if (footerText && !isTechnicalBuilderLabel(footerText)) return standardDynamicTemplateName(footerText);

    const authorName = stripCustomEmojiMarkup(data.author?.name || '').trim();
    if (authorName && !isTechnicalBuilderLabel(authorName)) return standardDynamicTemplateName(authorName);

    const context = String(stableSystemTemplateContext(data) || '').trim();
    const contextLeaf = context.split('/').filter(Boolean).at(-1) || '';
    if (contextLeaf) {
        return contextLeaf
            .split(/[-_]+/)
            .filter(Boolean)
            .map(part => {
                const lower = part.toLowerCase();
                if (lower === 'faq') return 'FAQ';
                if (lower === 'ai') return 'AI';
                return lower.charAt(0).toUpperCase() + lower.slice(1);
            })
            .join(' ');
    }

    return 'Embed';
}

function builderSourceCompleteness(record) {
    const data = recordEmbedData(record);
    let score = 0;
    if (data.description) score += 1000 + String(data.description).length;
    if (Array.isArray(data.fields)) score += data.fields.length * 500;
    if (data.footer?.text) score += 250;
    if (data.thumbnail?.url) score += 150;
    if (data.image?.url) score += 100;
    return score;
}

function isLegacyHelperParserArtifactRecord(record) {
    if (String(record?.source || '') !== 'system-catalog') return false;
    const data = recordEmbedData(record);
    if (isLegacyBalanceParserArtifact(data)) return true;
    const title = stripCustomEmojiMarkup(data.title || '').trim();
    const description = stripCustomEmojiMarkup(data.description || '').trim();
    if (!description && !data.fields?.length && /^change currency (?:name|symbol)$/i.test(title)) return true;
    if (/\/(?:embed-template-service|embed-color-picker-session-service|embed-color-picker-page|builder-runtime-preview-service)$/.test(stableSystemTemplateContext(data))) return true;
    if (!/^(?:success|error|information|warning)$/i.test(title) || !description) return false;

    const source = getSystemSourceDefinitionPreview(
        description,
        stableSystemTemplateContext(data),
    );
    if (!source) return false;

    const sourceTitle = stripCustomEmojiMarkup(source.title || '').trim();
    return sourceTitle.toLowerCase() === description.toLowerCase()
        && Boolean(source.description || source.fields?.length);
}

function containsDynamicPlaceholder(value) {
    if (/{dynamic}/i.test(String(value || ''))) return true;
    if (Array.isArray(value)) {
        return value.some(item => containsDynamicPlaceholder(item?.name) || containsDynamicPlaceholder(item?.value));
    }
    return false;
}

function isStaleDynamicSourceArtifactRecord(record) {
    if (String(record?.source || '') !== 'system-catalog') return false;
    const data = recordEmbedData(record);
    const stableKey = stableSystemTemplateKey(data);
    if (balanceResponseIdentity(data)) return false;
    if (!/^(?:embed|embed-type):/i.test(stableKey)) return false;
    if (!containsDynamicPlaceholder(data.title)) return false;

    // PR #131 temporarily allowed arbitrary calculated template literals into
    // static discovery. Keep a catalog-only dynamic row when it still maps to
    // a current source definition. Otherwise hide only placeholder-shaped
    // parser artifacts; real runtime captures keep their concrete body.
    if (getSystemSourceDefinitionPreviewForEmbed(data)) return false;
    return containsDynamicPlaceholder(data.description)
        || containsDynamicPlaceholder(data.fields);
}

function bestBuilderSourceRecord(records, fallback = null) {
    const sources = (records || [])
        .filter(record => String(record?.source || '') === 'system-catalog')
        .filter(record => !isLegacyHelperParserArtifactRecord(record))
        .sort((left, right) => {
            const scoreDelta = builderSourceCompleteness(left) - builderSourceCompleteness(right);
            if (scoreDelta) return scoreDelta;
            const leftTime = new Date(left?.updatedAt || left?.createdAt || 0).getTime();
            const rightTime = new Date(right?.updatedAt || right?.createdAt || 0).getTime();
            return leftTime - rightTime;
        });
    return sources.at(-1) || fallback;
}

// BUILDER_HUMAN_NAMES_V1


export function templateIdentity(channelId, value) {
    const data = value && typeof value === 'object' ? value : { title: value };
    const balanceIdentity = balanceResponseIdentity(data);
    if (balanceIdentity) return balanceIdentity;
    const ticketLog = canonicalTicketLogTemplate(data);
    if (ticketLog) return `ticket-log:${ticketLog.key}`;
    const visibleTitle = stripCustomEmojiMarkup(data.title || '');
    if (/^cloudy(?: support)? assistant$/i.test(visibleTitle)) return 'cloudy-assistant';
    const stableKey = stableSystemTemplateKey(data);
    // Old generic embed/source hashes are storage identities, not separate
    // response types. Named/game/ticket keys stay authoritative.
    if (/^(?:game:|ticket-log:|ticket-main$)/i.test(stableKey)) return stableKey;
    const source = getSystemSourceDefinitionPreviewForEmbed(data);
    const title = String(source?.title || data.title || '');
    const rule = getTemplateRule(channelId, title);
    if (rule) return rule.key;

    if (/^blackjack\s*[—-]\s*bet\b/i.test(title)) return 'game:blackjack:bet';
    if (/^baccarat\s*[—-]\s*bet\b/i.test(title)) return 'game:baccarat:bet';

    const titleShape = isTechnicalBuilderLabel(title) ? '' : canonicalBuilderResponseTitle(title);
    // A visible title defines the Builder template. Descriptions contain live
    // appeal/ticket answers and must never create separate entries.
    if (titleShape) return titleShape;

    const fieldShape = (data.fields || [])
        .map(field => dynamicTemplateText(field?.name || ''))
        .filter(Boolean)
        .join('|');
    const descriptionShape = dynamicTemplateText(data.description || '');
    return `${fieldShape}::${descriptionShape}`;
}

export function collapseDisplayRecords(channelRecords, channelId = null) {
    const strictTemplateMode = TEMPLATE_CHANNEL_IDS.has(String(channelId));
    const groups = new Map();

    for (const record of channelRecords) {
        if (isLegacyHelperParserArtifactRecord(record) || isStaleDynamicSourceArtifactRecord(record)) continue;
        const rawName = recordName(record);
        const recordData = recordEmbedData(record);
        const casinoTemplate = canonicalCasinoBuilderTemplate(recordData);
        if (casinoTemplate) {
            const key = `casino:${casinoTemplate.key}`;
            if (!groups.has(key)) groups.set(key, {
                label: casinoTemplate.label,
                records: [],
                templateMode: true,
                canonicalCasinoKey: casinoTemplate.key,
            });
            groups.get(key).records.push(record);
            continue;
        }

        const ticketLog = canonicalTicketLogTemplate(recordData);
        if (ticketLog) {
            const key = `ticket-log:${ticketLog.key}`;
            if (!groups.has(key)) groups.set(key, {
                label: ticketLog.label,
                records: [],
                templateMode: false,
                preventTemplateMode: true,
            });
            const group = groups.get(key);
            if (String(record.source || '') === 'ticket-log') {
                group.templateMode = true;
                group.preventTemplateMode = false;
            }
            group.records.push(record);
            continue;
        }
        if (isLegacyTicketLog(recordData)) continue;

        const rule = strictTemplateMode
            ? getChannelTemplateRule(channelId, rawName)
            : getTemplateRule(channelId, rawName);

        if (strictTemplateMode) {
            if (!rule) continue;
            if (!groups.has(rule.key)) groups.set(rule.key, { label: rule.label, records: [], templateMode: true });
            groups.get(rule.key).records.push(record);
            continue;
        }

        if (rule) {
            const key = 'template:' + rule.key;
            if (!groups.has(key)) groups.set(key, { label: rule.label, records: [], templateMode: true });
            groups.get(key).records.push(record);
            continue;
        }

        const stableKey = stableSystemTemplateKey(recordData);
        const name = stableKey === 'ticket-main'
            ? 'Ticket'
            : (humanTemplateRecordName(record) || 'Embed');
        const key = `template:${templateIdentity(channelId, recordData)}`;
        if (!groups.has(key)) groups.set(key, { label: name, records: [], templateMode: false });
        groups.get(key).records.push(record);
    }

    return [...groups.values()].map(group => {
        group.records.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        // Show the newest real message when there is one, so the Builder opens
        // with live cards/bets/cash. The hidden peers remain linked for Save.
        const realRecords = group.records.filter(record => record.source !== 'system-catalog');
        const canonicalCatalogRecords = group.canonicalCasinoKey
            ? group.records.filter(record => stableSystemTemplateKey(recordEmbedData(record)) === group.canonicalCasinoKey)
            : [];
        const sourceCatalogRecords = group.canonicalCasinoKey
            ? []
            : group.records.filter(record =>
                record.source === 'system-catalog'
                && /^(?:embed|embed-type):/i.test(stableSystemTemplateKey(recordEmbedData(record)))
            );
        // The hidden catalog master is the Save target for a reusable response
        // type. A real runtime message is preview data only. This prevents
        // slash-command/interactions from failing Save and guarantees one Save
        // changes the reusable template for every future matching response.
        const representative = canonicalCatalogRecords.at(-1)
            || sourceCatalogRecords.at(-1)
            || (realRecords.length ? realRecords.at(-1) : null)
            || group.records.at(-1);
        const previewRecord = [...realRecords].sort((a, b) => builderSourceCompleteness(a) - builderSourceCompleteness(b)
            || new Date(a.createdAt || 0) - new Date(b.createdAt || 0)).at(-1) || representative;
        const sourceRecord = bestBuilderSourceRecord(group.records, representative);
        const displayEmojiSource = group.records
            .map(record => recordEmbedData(record).title || record.title || record.name || '')
            .find(value => customEmojiOption(value)) || '';
        return {
            ...representative,
            name: group.label,
            displayEmojiSource,
            previewRecord,
            sourceRecord,
            duplicateCount: group.records.length,
            templateCount: group.records.length,
            templateMode: group.preventTemplateMode ? false : (Boolean(group.templateMode) || group.records.length > 1 || representative.source === 'system-catalog'),
        };
    });
}

// Search and channel navigation consume this same read-only canonical view.
// Physical catalog records remain the Save target; runtime records supply examples.
export async function getCanonicalBuilderRecords(guild, suppliedRecords = null, { perChannel = false } = {}) {
    let records = suppliedRecords || await getEmbedRegistry(guild.id);
    if (String(guild.id) === '1532882647838228723'
        && !records.some(record => String(record.messageId) === '1554543233047199787')) {
        const channel = guild.channels.cache.get('1554538634898710654');
        const guide = await channel?.messages?.fetch?.('1554543233047199787').catch(() => null);
        if (guide?.author?.id === guild.client.user.id) {
            await registerCloudyEmbedMessage(guide);
            const registered = await getEmbedRegistry(guild.id);
            records = [...records, ...registered.filter(record => String(record.messageId) === '1554543233047199787')];
        }
    }
    await warmSavedEmbedTemplateScopes(guild.id, records.map(record => record.channelId));
    const groups = new Map();
    for (const record of records) {
        if (isLegacyHelperParserArtifactRecord(record) || isStaleDynamicSourceArtifactRecord(record)) continue;
        const raw = record.snapshot || getEmbedRegistrySnapshot(record) || recordEmbedData(record);
        if (isRetiredGamblingEmbed(raw)) continue;
        const saved = getCachedSavedEmbedTemplateData(guild.id, record.channelId, raw);
        const identity = balanceResponseIdentity(raw) || saved.canonicalIdentity || templateIdentity(record.channelId, raw);
        if (!identity || identity === '::') continue;
        const groupKey = perChannel ? String(record.channelId) + '|' + identity : identity;
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push(record);
    }
    return [...groups.entries()].map(([groupKey, peers]) => {
        const identity = perChannel ? groupKey.slice(groupKey.indexOf('|') + 1) : groupKey;
        const catalogs = peers.filter(record => record.source === 'system-catalog');
        const live = peers.filter(record => record.source !== 'system-catalog' && !record.detached)
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
                || String(b.messageId).length - String(a.messageId).length
                || String(b.messageId).localeCompare(String(a.messageId)));
        const master = perChannel && live.length ? live[0] : bestBuilderSourceRecord(catalogs, live[0] || peers.at(-1));
        const data = recordEmbedData(master);
        const source = getSystemSourceDefinitionPreviewForEmbed(data);
        const hydrated = { ...(source || {}), ...data };
        const saved = getCachedSavedEmbedTemplateData(guild.id, master.channelId, hydrated);
        const snapshot = removeRetiredGamblingGuideCommand(saved.matched ? saved.data : hydrated);
        const canonical = {
            ...master, snapshot, canonicalIdentity: identity,
            title: snapshot.title || '', name: humanTemplateRecordName({ ...master, snapshot }),
            templateMode: true,
        };
        canonical.sourceRecord = { ...master, snapshot };
        canonical.previewRecord = { ...master, snapshot };
        return canonical;
    });
}

function channelOrderTuple(channel) {
    if (!channel) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, ''];
    const parentPosition = channel.parent
        ? (Number.isFinite(channel.parent.rawPosition) ? channel.parent.rawPosition : (channel.parent.position ?? 0))
        : -1;
    const channelPosition = Number.isFinite(channel.rawPosition) ? channel.rawPosition : (channel.position ?? 0);
    return [parentPosition, channelPosition, String(channel.id)];
}

function compareChannelsByDiscordOrder(a, b) {
    const aKey = channelOrderTuple(a.channel);
    const bKey = channelOrderTuple(b.channel);
    if (aKey[0] !== bKey[0]) return aKey[0] - bKey[0];
    if (aKey[1] !== bKey[1]) return aKey[1] - bKey[1];
    return aKey[2].localeCompare(bKey[2]);
}

const SAVED_TEMPLATE_CHANNEL_ID = '__cloudy_saved_templates__';

function builderDisplayChannelId(guild, record) {
    const logicalChannelId = String(record?.channelId || '');
    if (logicalChannelId && guild?.channels?.cache?.has?.(logicalChannelId)) return logicalChannelId;

    const backingChannelId = String(record?.backingChannelId || '');
    if (String(record?.source || '') === 'system-catalog'
        && backingChannelId
        && guild?.channels?.cache?.has?.(backingChannelId)) {
        return backingChannelId;
    }

    if (record?.detached) return SAVED_TEMPLATE_CHANNEL_ID;
    return logicalChannelId;
}

function builderDisplayChannel(guild, channelId) {
    if (String(channelId) === SAVED_TEMPLATE_CHANNEL_ID) {
        return {
            id: SAVED_TEMPLATE_CHANNEL_ID,
            name: 'Saved templates',
            type: 0,
            rawPosition: Number.MAX_SAFE_INTEGER,
            position: Number.MAX_SAFE_INTEGER,
            parent: null,
            messages: { fetch: async () => null },
            toString: () => 'Saved templates',
        };
    }
    return guild?.channels?.cache?.get?.(String(channelId)) || null;
}

// BUILDER_DURABLE_SNAPSHOT_V1
function buildChannelGroups(guild, records) {
    const groups = new Map();

    // Restore the original channel browser behavior: show every real
    // text/announcement channel, even when it currently has no saved embed.
    // Search remains the complete archive/catalog; only live/routed records are
    // attached to these channel rows.
    for (const channel of guild.channels.cache.values()) {
        if (![0, 5].includes(channel?.type) || !channel?.messages?.fetch) continue;
        groups.set(String(channel.id), []);
    }

    for (const record of filterEmbedManagerRecords(records)) {
        const channelId = String(record.channelId);
        if (!channelId || !groups.has(channelId)) continue;
        groups.get(channelId).push(record);
    }

    return [...groups.entries()]
        .map(([channelId, channelRecords]) => ({
            channelId,
            channel: builderDisplayChannel(guild, channelId),
            records: channelRecords.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)),
        }))
        .filter(group => Boolean(group.channel))
        .sort(compareChannelsByDiscordOrder);
}

function pageItems(items, page) {
    const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(Number(page) || 0, 0), pageCount - 1);
    const start = safePage * PAGE_SIZE;
    return { items: items.slice(start, start + PAGE_SIZE), safePage, pageCount, start };
}

function navigationRow(prefix, page, pageCount) {
    if (pageCount <= 1) return null;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${prefix}:${Math.max(0, page - 1)}`)
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 0),
        new ButtonBuilder()
            .setCustomId(`${prefix}:${Math.min(pageCount - 1, page + 1)}`)
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= pageCount - 1),
    );
}

export function createEmbedManagerChannelPager(guild) {
    let previousRecords = null;
    let groups = null;
    return (records, page = 0, checkingChannelIds = null) => {
        if (records !== previousRecords) {
            previousRecords = records;
            groups = buildChannelGroups(guild, records).map(group => ({
                ...group,
                embedCount: collapseDisplayRecords(builderRecordsForChannel(guild, group.channelId, group.records), group.channelId).length,
            }));
        }
        return buildChannelPayload(guild, records, page, checkingChannelIds, groups);
    };
}

export function buildChannelPayload(guild, records, page = 0, checkingChannelIds = null, preparedGroups = null) {
    const groups = preparedGroups || buildChannelGroups(guild, records).map(group => ({
        ...group,
        embedCount: collapseDisplayRecords(builderRecordsForChannel(guild, group.channelId, group.records), group.channelId).length,
    }));
    const result = pageItems(groups, page);
    const components = [];

    if (result.items.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(`simple_embed_modify_channel:${result.safePage}`)
            .setPlaceholder('Choose a channel')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(...result.items.map(group => {
                const name = group.channel?.name ? `# ${group.channel.name}` : 'Unknown channel';
                const count = group.embedCount;
                const checking = !count && checkingChannelIds?.has?.(String(group.channelId));
                return new StringSelectMenuOptionBuilder()
                    .setLabel(shortLabel(name))
                    .setDescription(count
                        ? 'Open the saved embed'
                        : (checking ? 'Checking saved embeds…' : 'No saved embed yet'))
                    .setValue(group.channelId);
            }));
        components.push(new ActionRowBuilder().addComponents(select));
    }

    const nav = navigationRow('simple_embed_modify_channel_page', result.safePage, result.pageCount);
    if (nav) components.push(nav);

    return {
        embeds: [new EmbedBuilder()
            .setTitle('Modify embed')
            .setDescription([
                'Choose a channel first, then choose the embed you want to edit.',
                '',
                `**Embeds found:** ${groups.reduce((sum, group) => sum + group.embedCount, 0)}`,
                `**Channels:** ${groups.length}`,
                `**Page:** ${result.safePage + 1}/${result.pageCount}`,
            ].join('\n'))
            .setColor(0xFFFFFF)],
        components,
    };
}

export function buildEmbedPayload(guild, records, channelId, page = 0) {
    const channel = builderDisplayChannel(guild, channelId);
    const visibleChannelRecords = filterEmbedManagerRecords(records)
        .filter(record => String(record.channelId) === String(channelId))
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    const channelRecords = builderRecordsForChannel(guild, channelId, visibleChannelRecords);
    const strictTemplateMode = TEMPLATE_CHANNEL_IDS.has(String(channelId));
    const displayRecords = collapseDisplayRecords(channelRecords, channelId);
    const result = pageItems(displayRecords, page);
    const components = [];

    if (result.items.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(`simple_embed_modify_embed:${channelId}:${result.safePage}`)
            .setPlaceholder('Choose an embed')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(...result.items.map(record => {
                const name = recordName(record) || record.name || 'Embed';
                const isTemplate = Boolean(record.templateMode);
                const displayName = isTemplate ? record.name : stripCustomEmojiMarkup(name);
                const description = isTemplate
                    ? `Edit this template • applies to ${record.templateCount || 1} matching embed(s)`
                    : 'Edit this embed';
                const option = new StringSelectMenuOptionBuilder()
                    .setLabel(shortLabel(displayName, 'Embed'))
                    .setDescription(description.slice(0, 100))
                    .setValue(`${record.messageId}:${record.embedIndex || 0}`);
                const emoji = customEmojiOption(record.displayEmojiSource || recordEmbedData(record).title || record.title || record.name);
                if (emoji) option.setEmoji(emoji);
                return option;
            }));
        components.push(new ActionRowBuilder().addComponents(select));
    }

    const nav = navigationRow(`simple_embed_modify_embed_page:${channelId}`, result.safePage, result.pageCount);
    if (nav) components.push(nav);

    components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_modify_back')
            .setLabel('Back to channels')
            .setStyle(ButtonStyle.Secondary),
    ));

    return {
        embeds: [new EmbedBuilder()
            .setTitle('Modify embed')
            .setDescription([
                `**Channel:** ${channel ? `${channel}` : `#${channelId}`}`,
                strictTemplateMode ? `**Templates:** ${displayRecords.length}` : `**Embeds:** ${displayRecords.length}`,
                `**Page:** ${result.safePage + 1}/${result.pageCount}`,
                '',
                strictTemplateMode
                    ? 'Only real log templates for this channel are shown. Old unrelated embeds and duplicates are ignored.'
                    : 'Only unique embeds are shown. Repeated Cloudy templates are grouped automatically.',
            ].join('\n'))
            .setColor(0xFFFFFF)],
        components,
    };
}

export function loadRecordSnapshotIntoState(
    state,
    guild,
    record,
    previewRecord = null,
    sourceRecord = null,
) {
    const snapshot = record?.snapshot || getEmbedRegistrySnapshot(record);
    if (!snapshot || typeof snapshot !== 'object' || !Object.keys(snapshot).length) return false;

    const data = migrateCloudyLogoEmbedData(snapshot).data || {};
    const previewSnapshot = previewRecord
        ? (previewRecord?.snapshot || getEmbedRegistrySnapshot(previewRecord))
        : null;
    const previewData = previewSnapshot && typeof previewSnapshot === 'object' && Object.keys(previewSnapshot).length
        ? recordEmbedData(previewRecord)
        : null;
    const effectiveSourceRecord = sourceRecord || record?.sourceRecord || null;
    const sourceSnapshot = effectiveSourceRecord
        ? (effectiveSourceRecord?.snapshot || getEmbedRegistrySnapshot(effectiveSourceRecord))
        : null;
    const sourceData = sourceSnapshot && typeof sourceSnapshot === 'object' && Object.keys(sourceSnapshot).length
        ? recordEmbedData(effectiveSourceRecord)
        : null;
    const sourcePreviewData = getSystemSourceDefinitionPreviewForEmbed(
        sourceData && Object.keys(sourceData).length ? sourceData : data,
    );
    const templateSourceData = {
        ...(sourcePreviewData || {}),
        ...(sourceData || {}),
    };

    // A live/history peer can exist but still be sparse. Merge each visible
    // piece independently so one title-only peer can never hide the complete
    // source definition from the Builder preview.
    let displayTitle = previewData?.title
        || sourceData?.title
        || data.title
        || sourcePreviewData?.title;
    let displayDescription = previewData?.description
        || sourceData?.description
        || data.description
        || sourcePreviewData?.description;
    let displayFields = Array.isArray(previewData?.fields) && previewData.fields.length
        ? previewData.fields
        : (Array.isArray(sourcePreviewData?.fields) && sourcePreviewData.fields.length
            ? sourcePreviewData.fields
            : (Array.isArray(sourceData?.fields) && sourceData.fields.length
                ? sourceData.fields
                : data.fields));
    let displayFooter = previewData?.footer
        || sourcePreviewData?.footer
        || sourceData?.footer
        || data.footer;
    let displayImage = previewData?.image
        || sourcePreviewData?.image
        || sourceData?.image
        || data.image;
    let displayThumbnail = previewData?.thumbnail
        || sourcePreviewData?.thumbnail
        || sourceData?.thumbnail
        || data.thumbnail;
    const displaySourceData = {
        ...(sourcePreviewData || {}),
        ...(previewData || {}),
        ...(displayTitle ? { title: displayTitle } : {}),
        ...(displayDescription != null ? { description: displayDescription } : {}),
        ...(Array.isArray(displayFields) ? { fields: displayFields } : {}),
        ...(displayFooter ? { footer: displayFooter } : {}),
        ...(displayImage ? { image: displayImage } : {}),
        ...(displayThumbnail ? { thumbnail: displayThumbnail } : {}),
    };
    const savedDisplay = getCachedSavedEmbedTemplateData(guild.id, String(record.channelId || ''), displaySourceData);
    if (savedDisplay.matched) {
        Object.assign(displaySourceData, savedDisplay.data);
        for (const key of ['title', 'description', 'fields', 'footer', 'image', 'thumbnail']) {
            if (!(key in savedDisplay.data)) delete displaySourceData[key];
        }
        displayTitle = savedDisplay.data.title;
        displayDescription = savedDisplay.data.description;
        displayFields = savedDisplay.data.fields;
        displayFooter = savedDisplay.data.footer;
        displayImage = savedDisplay.data.image;
        displayThumbnail = savedDisplay.data.thumbnail;
    }
    const footerText = cleanFooter(displayFooter?.text || '');
    const logicalChannelId = String(record.channelId || '');
    const backingChannelId = String(record.backingChannelId || record.channelId || '');
    const templateRule = getTemplateRule(logicalChannelId, recordName(record) || data.title);
    const templateKind = stableSystemTemplateKind(sourceData || {})
        || stableSystemTemplateKind(data);

    state.title = templateKind === 'content' ? null : (displayTitle || null);
    state.message = displayDescription || null;
    state.embedFields = Array.isArray(displayFields)
        ? displayFields.map(field => ({
            name: String(field.name || '').slice(0, 256),
            value: String(field.value || '').slice(0, 1024),
            inline: Boolean(field.inline),
        }))
        : [];
    state.sideColor = savedDisplay.matched && Number.isInteger(savedDisplay.data.color)
        ? savedDisplay.data.color
        : Number.isInteger(previewData?.color)
        ? previewData.color
        : (Number.isInteger(sourcePreviewData?.color)
            ? sourcePreviewData.color
            : (Number.isInteger(sourceData?.color)
                ? sourceData.color
                : (Number.isInteger(data.color) ? data.color : 0xFFFFFF)));
    state.showLogo = isCloudyLogoUrl(displayThumbnail?.url) || (!displayThumbnail && !data.footer?.text);
    state.removeExistingLogo = false;
    state.bottomLine = footerText || null;
    state.mediaUrl = displayImage?.url || null;
    state.mediaBuffer = null;
    state.mediaName = null;
    state.mediaConvertedFromVideo = false;
    state.pendingBuilderDelete = null;
    state.modifyTarget = {
        guildId: guild.id,
        channelId: logicalChannelId,
        backingChannelId,
        messageId: String(record.messageId),
        embedIndex: Number(record.embedIndex || 0),
        source: record.source || 'cloudy',
        sourceEmbedData: data,
        templateSourceData,
        previewSourceData: displaySourceData,
        hadBuilderMarker: Boolean(data.footer?.text?.endsWith(MESSAGE_BUILDER_FOOTER_MARKER)),
        templateMode: Boolean(record.templateMode) || Boolean(templateRule) || record.source !== 'embed-builder',
        templateTitle: record.canonicalIdentity || templateRule?.key || templateIdentity(
            logicalChannelId,
            Object.keys(templateSourceData).length ? templateSourceData : data,
        ),
        templateKind,
        catalogTitle: templateSourceData.title || data.title || null,
        detached: Boolean(record.detached),
        cachedMessage: null,
    };
    return true;
}

export function applyInitialSearchSelectionToState(interaction, state) {
    const initialSelection = interaction?.__cloudyInitialBuilderSelection;
    const record = initialSelection?.record;
    if (!record || !state || !interaction?.guild) return false;

    const selectedRecord = {
        ...record,
        previewRecord: initialSelection.previewRecord || record.previewRecord || null,
        sourceRecord: initialSelection.sourceRecord || record.sourceRecord || null,
    };
    const loaded = loadRecordSnapshotIntoState(
        state, interaction.guild, selectedRecord,
        selectedRecord.previewRecord, selectedRecord.sourceRecord,
    );
    if (loaded) delete interaction.__cloudyInitialBuilderSelection;
    return loaded;
}

function loadEmbedIntoState(state, resolved) {
    const { record, channel, message, embed } = resolved;
    const data = migrateCloudyLogoEmbedData(embed).data || {};
    const footerText = cleanFooter(data.footer?.text || '');
    // System-catalog messages physically live in #botlog, but their record
    // points to the feature channel where future responses are sent.
    const logicalChannelId = String(record.channelId || channel.id);
    const templateRule = getTemplateRule(logicalChannelId, recordName(record) || data.title);
    const templateKind = stableSystemTemplateKind(data);

    state.title = templateKind === 'content' ? null : (data.title || null);
    state.message = data.description || null;
    state.embedFields = Array.isArray(data.fields)
        ? data.fields.map(field => ({
            name: String(field.name || '').slice(0, 256),
            value: String(field.value || '').slice(0, 1024),
            inline: Boolean(field.inline),
        }))
        : [];
    state.sideColor = Number.isInteger(data.color) ? data.color : 0xFFFFFF;
    state.showLogo = isCloudyLogoUrl(data.thumbnail?.url) || (!data.thumbnail && !data.footer?.text);
    state.removeExistingLogo = false;
    state.bottomLine = footerText || null;
    state.mediaUrl = data.image?.url || null;
    state.mediaBuffer = null;
    state.mediaName = null;
    state.mediaConvertedFromVideo = false;
    state.pendingBuilderDelete = null;
    state.modifyTarget = {
        guildId: message.guildId,
        channelId: logicalChannelId,
        backingChannelId: String(channel.id),
        messageId: message.id,
        embedIndex: Number(record.embedIndex || 0),
        source: record.source || 'cloudy',
        sourceEmbedData: data,
        hadBuilderMarker: Boolean(data.footer?.text?.endsWith(MESSAGE_BUILDER_FOOTER_MARKER)),
        templateMode: Boolean(record.templateMode) || Boolean(templateRule) || record.source !== 'embed-builder',
        templateTitle: templateRule?.key || templateIdentity(logicalChannelId, data),
        templateKind,
        catalogTitle: data.title || null,
        cachedMessage: message,
    };
    loadBuilderComponentsFromMessage(state, message);
}

async function refreshSelectedBuilderComponents(guild, state, refreshBuilder, expectedMessageId) {
    const targetId = String(expectedMessageId || state?.modifyTarget?.messageId || '');
    if (!targetId || String(state?.modifyTarget?.messageId || '') !== targetId) return false;

    const changed = await hydrateBuilderMessageComponents(guild, state).catch(() => false);
    if (!changed || String(state?.modifyTarget?.messageId || '') !== targetId) return false;

    await Promise.resolve(refreshBuilder()).catch(() => {});
    return true;
}

function isEmbedManagerComponent(interaction) {
    const customId = String(interaction?.customId || '');
    return customId === 'simple_embed_modify_back'
        || customId.startsWith('simple_embed_modify_channel:')
        || customId.startsWith('simple_embed_modify_channel_page:')
        || customId.startsWith('simple_embed_modify_embed:')
        || customId.startsWith('simple_embed_modify_embed_page:');
}

function buildEmptyManagerPayload() {
    return {
        embeds: [new EmbedBuilder()
            .setTitle('Modify embed')
            .setDescription('No embeds are registered yet. Older embeds are being imported in the background; reopen this menu in a moment.')
            .setColor(0xFFFFFF)],
        components: [],
    };
}

function closeEmbedManagerSession(state, session, reason = 'closed') {
    if (!session || session.closed) return;
    session.closed = true;
    if (session.collector && !session.collector.ended) session.collector.stop(reason);
    if (state.activeEmbedManager === session) state.activeEmbedManager = null;
}

export function shouldApplyBackgroundRegistryRefresh(state, session) {
    return Boolean(session)
        && !session.closed
        && state.activeEmbedManager === session
        && !session.hasInteracted;
}

async function updateEmbedManager(interaction, payload, state, session) {
    if (session.closed || state.activeEmbedManager !== session) return false;

    try {
        if (!interaction.deferred && !interaction.replied && typeof interaction.update === 'function') {
            await interaction.update(payload);
        } else {
            await interaction.editReply(payload);
        }
        return true;
    } catch (error) {
        if (CLOSED_MANAGER_ERROR_CODES.has(error?.code)) {
            closeEmbedManagerSession(state, session, 'message-unavailable');
            logger.debug(`Embed manager message ${session.messageId} is no longer available.`);
            return false;
        }
        throw error;
    }
}

function managerRecordKey(record) {
    return [
        String(record?.backingChannelId || record?.channelId || ''),
        String(record?.messageId || ''),
        Math.max(0, Number(record?.embedIndex) || 0),
    ].join(':');
}

export function isEmbedManagerVisibleRecord(record, { includeBotHistory = true } = {}) {
    if (!record?.messageId || record.detached) return false;

    const source = String(record.source || '').toLowerCase();

    // Full runtime/history capture belongs to Search. The channel browser may
    // show those records only after live reconciliation has confirmed them.
    if (!includeBotHistory && source === 'bot-history') return false;

    // The system catalog physically lives in botlog. Generic catalog-only
    // responses belong to Search; only templates virtually placed into a real
    // feature channel (tickets, gambling, etc.) belong in the channel browser.
    if (source === 'system-catalog') {
        const logicalChannelId = String(record.channelId || '');
        const backingChannelId = String(record.backingChannelId || '');
        return Boolean(
            logicalChannelId
            && backingChannelId
            && logicalChannelId !== backingChannelId
        );
    }

    return true;
}

export function filterEmbedManagerRecords(records = [], options = {}) {
    return (Array.isArray(records) ? records : [])
        .filter(record => isEmbedManagerVisibleRecord(record, options));
}

export function mergeEmbedManagerRecords(baseRecords = [], additions = []) {
    const merged = new Map();
    for (const record of filterEmbedManagerRecords([...baseRecords, ...additions])) {
        merged.set(managerRecordKey(record), record);
    }
    return [...merged.values()];
}

function channelHasVisibleManagerRecord(records, channelId) {
    const relevant = records.filter(record =>
        String(record?.channelId || '') === String(channelId)
        || String(record?.backingChannelId || '') === String(channelId),
    );
    return collapseDisplayRecords(relevant, channelId).length > 0;
}

export function embedManagerCheckingChannelIds(guild, records) {
    return new Set(
        [...(guild?.channels?.cache?.values?.() || [])]
            .filter(channel =>
                [0, 5].includes(channel?.type)
                && channel?.messages?.fetch
                && !channelHasVisibleManagerRecord(records, channel.id),
            )
            .map(channel => String(channel.id)),
    );
}

export async function discoverEmbedManagerOverviewRecords(guild, records, botUserId) {
    if (!guild || !botUserId) return [];

    const channels = [...guild.channels.cache.values()].filter(channel =>
        [0, 5].includes(channel?.type)
        && channel?.messages?.fetch
        && !channelHasVisibleManagerRecord(records, channel.id),
    );
    if (!channels.length) return [];

    const discovered = [];
    let cursor = 0;

    const workers = Array.from(
        { length: Math.min(OVERVIEW_DISCOVERY_CONCURRENCY, channels.length) },
        async () => {
            while (cursor < channels.length) {
                const channel = channels[cursor++];
                const found = await discoverRecentChannelEmbeds(
                    guild,
                    channel.id,
                    botUserId,
                ).catch(error => {
                    logger.debug(`Embed manager overview discovery skipped for #${channel?.name || channel?.id}: ${error?.message || error}`);
                    return [];
                });
                discovered.push(...found);
            }
        },
    );

    await Promise.all(workers);
    return discovered;
}

async function loadCurrentRegistry(guild, botUserId) {
    // Opening the Builder must be a local/DB operation. Reconciling the entire
    // registry resolves every stored Discord message and grows linearly with the
    // catalog. Only bootstrap from Discord when the registry is genuinely empty.
    const records = await getEmbedRegistry(guild.id);
    if (records.length) return records;

    await refreshRecentEmbedHistory(guild, botUserId, true);
    const result = await reconcileEmbedRegistry(guild);
    return result.records;
}

async function refreshRecentEmbedHistory(guild, botUserId, force = false) {
    if (historyScanJobs.has(guild.id)) return historyScanJobs.get(guild.id);
    if (!force && Date.now() - (historyScanTimes.get(guild.id) || 0) < HISTORY_SCAN_TTL) return null;

    const job = (async () => {
        try {
            const scan = await scanGuildForCloudyEmbeds(guild, botUserId, { maxMessagesPerChannel: 25 });
            await reconcileEmbedRegistry(guild);
            historyScanTimes.set(guild.id, Date.now());
            return scan;
        } finally {
            historyScanJobs.delete(guild.id);
        }
    })();

    historyScanJobs.set(guild.id, job);
    return job;
}

export function prepareEmbedManager(guild, state) {
    if (!guild?.id || state.embedManagerPrepared) return;
    // Preserve the existing live-only channel browser contents. Only prefetch its
    // persisted records; no Discord history scan or catalog rewrite is involved.
    state.embedManagerPreparedGeneration = getEmbedRegistryGeneration(guild.id);
    state.embedManagerPrepared = getEmbedRegistry(guild.id).catch(error => {
        logger.debug(`Channel browser preload skipped: ${error?.message || error}`);
        return null;
    });
}

export async function openEmbedManager(buttonInteraction, state, refreshBuilder) {
    const guild = buttonInteraction.guild;
    if (!guild || !buttonInteraction.client.user?.id) return;
    const channelPage = createEmbedManagerChannelPager(guild);
    // Fast opens reply directly. Slow storage must not expire the component:
    // deferUpdate is silent and keeps the exact existing private follow-up flow.
    let pendingAcknowledgement = null;
    const acknowledgementTimer = setTimeout(() => {
        if (!buttonInteraction.deferred && !buttonInteraction.replied) {
            pendingAcknowledgement = buttonInteraction.deferUpdate().catch(() => {});
        }
    }, 750);
    acknowledgementTimer.unref?.();

    try {
        const previousSession = state.activeEmbedManager;
        if (previousSession) {
            closeEmbedManagerSession(state, previousSession, 'replaced');
            if (previousSession.messageId) {
                void buttonInteraction.webhook.deleteMessage(previousSession.messageId).catch(() => {});
            }
        }

        // Render immediately from the local registry. Empty rows are explicitly
        // marked as "Checking" rather than falsely claiming there is no saved
        // embed. Discord lookups run in the background and fill those rows in.
        const prepared = state.embedManagerPrepared;
        delete state.embedManagerPrepared;
        const preparedGeneration = state.embedManagerPreparedGeneration;
        delete state.embedManagerPreparedGeneration;
        const preparedRecords = prepared && await prepared;
        const allStoredRecords = preparedRecords && preparedGeneration === getEmbedRegistryGeneration(guild.id)
            ? preparedRecords : await getEmbedRegistry(guild.id);
        // Do not flash stale history rows while live reconciliation is still
        // running. Manual Builder records and routed future templates appear
        // immediately; verified live bot-history records are merged in shortly.
        const storedRecords = filterEmbedManagerRecords(
            allStoredRecords,
            { includeBotHistory: false },
        );
        let liveOverviewRecords = [];
        let records = [...storedRecords];
        const checkingChannelIds = embedManagerCheckingChannelIds(guild, storedRecords);
        const initialPayload = guild.channels.cache.size
            ? channelPage(records, 0, checkingChannelIds)
            : buildEmptyManagerPayload();
        clearTimeout(acknowledgementTimer);
        if (pendingAcknowledgement) await pendingAcknowledgement;
        let managerMessage;
        if (typeof buttonInteraction.reply === 'function'
            && !buttonInteraction.deferred && !buttonInteraction.replied) {
            const response = await buttonInteraction.reply({
                ...initialPayload,
                flags: MessageFlags.Ephemeral,
                withResponse: true,
            });
            managerMessage = response?.resource?.message;
            // Some adapters return the Message directly instead of an API response.
            if (!managerMessage && response?.createMessageComponentCollector) managerMessage = response;
            if (!managerMessage) managerMessage = await buttonInteraction.fetchReply();
        } else {
            if (!buttonInteraction.deferred && !buttonInteraction.replied) {
                await buttonInteraction.deferUpdate();
            }
            managerMessage = await buttonInteraction.followUp({
                ...initialPayload,
                flags: MessageFlags.Ephemeral,
                fetchReply: true,
            });
        }
        if (!managerMessage) return;
        // Direct callback replies bypass InteractionWebhook.send, so retain
        // the exact existing ownership, inactivity and ephemeral cleanup hooks.
        linkBuilderSessionMessages(buttonInteraction.message, managerMessage);
        touchBuilderSessionMessage(managerMessage, () => buttonInteraction.webhook.deleteMessage(managerMessage.id));

        const session = {
            messageId: managerMessage.id,
            collector: null,
            closed: false,
            queue: Promise.resolve(),
            hasInteracted: false,
        };
        state.activeEmbedManager = session;

        const collector = managerMessage.createMessageComponentCollector({
            filter: interaction =>
                interaction.user.id === buttonInteraction.user.id &&
                isEmbedManagerComponent(interaction),
            idle: MANAGER_IDLE_TIMEOUT,
        });
        session.collector = collector;
        registerBuilderSessionCollector(managerMessage, collector);

        void Promise.all([
            Promise.resolve([]),
            loadCurrentRegistry(guild, buttonInteraction.client.user.id)
                .catch(error => {
                    logger.error('Embed manager registry refresh failed:', error);
                    return storedRecords;
                }),
        ]).then(async ([discoveredRecords, refreshedRecords]) => {
            liveOverviewRecords = discoveredRecords;
            if (!shouldApplyBackgroundRegistryRefresh(state, session)) return;

            records = mergeEmbedManagerRecords(
                mergeEmbedManagerRecords(
                    filterEmbedManagerRecords(refreshedRecords),
                    storedRecords,
                ),
                filterEmbedManagerRecords(liveOverviewRecords),
            );

            await buttonInteraction.webhook.editMessage(
                managerMessage.id,
                channelPage(records, 0),
            ).catch(error => {
                if (!CLOSED_MANAGER_ERROR_CODES.has(error?.code)) {
                    logger.error('Failed to refresh the embed manager registry:', error);
                }
            });
        });

        collector.on('collect', async interaction => {
            touchBuilderSessionMessage(managerMessage);
            session.hasInteracted = true;
            const selectionVersion = (session.selectionVersion || 0) + 1;
            session.selectionVersion = selectionVersion;
            discardPendingEmbedEditorUpdates(state.colorSessionToken);

            void (async () => {
                if (session.closed || state.activeEmbedManager !== session) return;
                if (selectionVersion !== session.selectionVersion) return;

                if (interaction.customId === 'simple_embed_modify_back') {
                    await updateEmbedManager(interaction, channelPage(records, 0), state, session);
                    return;
                }

                if (interaction.customId.startsWith('simple_embed_modify_channel_page:')) {
                    const page = Number(interaction.customId.split(':').at(-1)) || 0;
                    await updateEmbedManager(interaction, channelPage(records, page), state, session);
                    return;
                }

                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {
                    const channelId = interaction.values?.[0];

                    // Paint instantly from the canonical records already loaded for
                    // this manager session. Fresh Discord/registry discovery runs
                    // after the visible response, so a slow channel can never hold
                    // the channel picker spinner open.
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, 0), state, session);
                    if (selectionVersion !== session.selectionVersion) return;

                    void (async () => {
                        const [discoveredRecords, registeredRecords] = await Promise.all([
                            discoverRecentChannelEmbeds(guild, channelId, buttonInteraction.client.user.id)
                                .catch(error => {
                                    logger.debug('Channel embed discovery skipped: ' + error.message);
                                    return [];
                                }),
                            getEmbedRegistry(guild.id).catch(error => {
                                logger.debug('Channel registry refresh skipped: ' + error.message);
                                return [];
                            }),
                        ]);

                        if (selectionVersion !== session.selectionVersion
                            || session.closed
                            || state.activeEmbedManager !== session) return;

                        const refreshedRecords = await getCanonicalBuilderRecords(
                            guild,
                            mergeEmbedManagerRecords(registeredRecords, discoveredRecords),
                            { perChannel: true },
                        ).catch(error => {
                            logger.debug('Canonical channel refresh skipped: ' + error.message);
                            return null;
                        });
                        if (!refreshedRecords
                            || selectionVersion !== session.selectionVersion
                            || session.closed
                            || state.activeEmbedManager !== session) return;

                        records = refreshedRecords;
                        await updateEmbedManager(
                            interaction,
                            buildEmbedPayload(guild, records, channelId, 0),
                            state,
                            session,
                        );
                    })();

                    return;
                }

                if (interaction.customId.startsWith('simple_embed_modify_embed_page:')) {
                    const parts = interaction.customId.split(':');
                    const channelId = parts[1];
                    const page = Number(parts[2]) || 0;
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, page), state, session);
                    return;
                }

                if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith('simple_embed_modify_embed:')) {
                    return;
                }

                await interaction.deferUpdate();
                const parts = interaction.customId.split(':');
                const channelId = parts[1];
                const page = Number(parts[2]) || 0;
                const [messageId, embedIndexRaw] = String(interaction.values?.[0] || '').split(':');
                const embedIndex = Number(embedIndexRaw) || 0;

                const selectedDisplayRecord = collapseDisplayRecords(
                    records.filter(item => builderDisplayChannelId(guild, item) === String(channelId)),
                    channelId,
                ).find(item =>
                    String(item.messageId) === String(messageId)
                    && Number(item.embedIndex || 0) === embedIndex
                );
                let previewRecord = selectedDisplayRecord?.previewRecord || null;
                const sourceRecord = selectedDisplayRecord?.sourceRecord || null;

                let record = records.find(item =>
                    builderDisplayChannelId(guild, item) === String(channelId) &&
                    String(item.messageId) === String(messageId) &&
                    Number(item.embedIndex || 0) === embedIndex,
                );

                if (!record) {
                    records = filterEmbedManagerRecords(await getEmbedRegistry(guild.id));
                    record = records.find(item =>
                        String(item.channelId) === String(channelId) &&
                        String(item.messageId) === String(messageId) &&
                        Number(item.embedIndex || 0) === embedIndex,
                    );
                }

                if (record) previewRecord = await hydrateBuilderPreviewRecord(guild, record, previewRecord, interaction.user.id).catch(() => previewRecord);
                let loaded = record ? loadRecordSnapshotIntoState(state, guild, record, previewRecord, sourceRecord) : false;
                if (!loaded) {
                    const resolved = record ? await resolveEmbedRegistryRecord(guild, record) : null;
                    if (selectionVersion !== session.selectionVersion) return;
                    if (!resolved) {
                        await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, page), state, session);
                        return;
                    }
                    loadEmbedIntoState(state, resolved);
                    loaded = true;
                }

                // The manager selection and the Builder preview are separate
                // Discord messages. Update both concurrently so one REST edit
                // cannot delay the other; the same payloads and state are used.
                await Promise.all([
                    Promise.resolve(refreshBuilder()).catch(error => {
                        logger.debug(`Embed preview refresh skipped: ${error?.message || error}`);
                    }),
                    updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, page), state, session),
                ]);
                if (selectionVersion !== session.selectionVersion) return;
                if (record?.snapshot && loaded) {
                    void refreshSelectedBuilderComponents(guild, state, refreshBuilder, messageId);
                }
            })().catch(error => {
                logger.error('Embed manager selection failed:', error);
            });
        });

        collector.on('end', () => {
            closeEmbedManagerSession(state, session, 'collector-ended');
        });
    } catch (error) {
        clearTimeout(acknowledgementTimer);
        if (pendingAcknowledgement) await pendingAcknowledgement;
        logger.error('Embed manager failed:', error);
        const errorResponse = (!buttonInteraction.deferred && !buttonInteraction.replied && buttonInteraction.reply)
            ? buttonInteraction.reply.bind(buttonInteraction)
            : buttonInteraction.followUp.bind(buttonInteraction);
        await errorResponse({
            embeds: [new EmbedBuilder()
                .setTitle('Could not load embeds')
                .setDescription('The embeds could not be loaded right now.')
                .setColor(getColor('error'))],
            flags: MessageFlags.Ephemeral,
        }).catch(() => {});
    }
}

function isZorpGuideTitle(value) {
    const title = String(value || '')
        .replace(/<a?:[^:>]+:\d+>/g, '')
        .replace(/^(?:\s|☑️|🛡️)+/u, '')
        .trim();
    return /^ZORP Guide$/i.test(title);
}

function capturedDynamicValues(templateText, liveText) {
    const template = String(templateText || '');
    const live = String(liveText || '');
    if (!template.includes('{dynamic}')) return [];

    const parts = template.split('{dynamic}');
    if (parts[0] && !live.startsWith(parts[0])) return [];

    const values = [];
    let cursor = parts[0].length;

    for (let index = 1; index < parts.length; index += 1) {
        const literal = parts[index];
        if (index === parts.length - 1 && !literal) {
            values.push(live.slice(cursor));
            cursor = live.length;
            continue;
        }

        const nextIndex = live.indexOf(literal, cursor);
        if (nextIndex === -1) return [];
        values.push(live.slice(cursor, nextIndex));
        cursor = nextIndex + literal.length;
    }

    return cursor === live.length ? values : [];
}

function restoreDynamicTemplateText(templateText, liveText, editedText) {
    const template = String(templateText || '');
    const live = String(liveText || '');
    const edited = String(editedText || '');

    if (!template.includes('{dynamic}')) return edited;
    // Restore variable slots only; unchanged visible text must never restore
    // the default source's old capitalization, labels or wording.
    if (edited === live && template === live) return edited;

    const values = capturedDynamicValues(template, live);
    if (!values.length) return edited;

    let restored = edited;
    for (const value of values) {
        if (!value) continue;
        const index = restored.indexOf(value);
        if (index === -1) continue;
        restored = restored.slice(0, index) + '{dynamic}' + restored.slice(index + value.length);
    }
    return restored;
}

function applyStateToExistingEmbed(state) {
    const target = state.modifyTarget;
    const data = { ...(target?.sourceEmbedData || {}) };

    if (target?.templateKind === 'content') {
        if (target.catalogTitle) data.title = String(target.catalogTitle).slice(0, 256);
        else if (!data.title) data.title = 'Message';
    } else if (state.title) data.title = state.title.slice(0, 256);
    else delete data.title;
    const zorp = isZorpGuideTitle(state.title || data.title);
    if (state.message) data.description = normalizeManualIndent(state.message, { zorp }).slice(0, 4096);
    else delete data.description;
    if (Array.isArray(state.embedFields) && state.embedFields.length) {
        data.fields = state.embedFields.slice(0, 25).map(field => ({
            name: String(field.name || '\u200B').slice(0, 256),
            value: normalizeManualIndent(String(field.value || '\u200B'), { zorp }).slice(0, 1024),
            inline: Boolean(field.inline),
        }));
    } else {
        delete data.fields;
    }

    const previewSource = target?.previewSourceData;
    const templateSource = target?.templateSourceData || target?.sourceEmbedData;
    if (previewSource && templateSource) {
        if (data.title && templateSource.title) {
            data.title = restoreDynamicTemplateText(templateSource.title, previewSource.title, data.title).slice(0, 256);
        }
        if (data.description && templateSource.description) {
            data.description = restoreDynamicTemplateText(
                templateSource.description,
                previewSource.description,
                data.description,
            ).slice(0, 4096);
        }
        if (Array.isArray(data.fields) && Array.isArray(templateSource.fields)) {
            data.fields = data.fields.map((field, index) => {
                const templateField = templateSource.fields[index] || {};
                const liveField = previewSource.fields?.[index] || {};
                return {
                    ...field,
                    name: templateField.name
                        ? restoreDynamicTemplateText(templateField.name, liveField.name, field.name).slice(0, 256)
                        : field.name,
                    value: templateField.value
                        ? restoreDynamicTemplateText(templateField.value, liveField.value, field.value).slice(0, 1024)
                        : field.value,
                };
            });
        }
    }

    if (target?.templateTitle === BALANCE_RESPONSE_KEY) {
        data.author = { ...(data.author || {}), name: `Cloudy template key: ${BALANCE_RESPONSE_KEY} || Cloudy context: gambling/balance || Cloudy kind: embed` };
    }
    data.color = state.sideColor;

    if (state.removeExistingLogo) delete data.thumbnail;
    else if (state.showLogo) data.thumbnail = { url: CLOUDY_LOGO_URL };
    else if (isCloudyLogoUrl(data.thumbnail?.url)) delete data.thumbnail;

    if (state.bottomLine) {
        const marker = target?.hadBuilderMarker ? MESSAGE_BUILDER_FOOTER_MARKER : '';
        const limit = marker ? 2047 : 2048;
        data.footer = { ...(data.footer || {}), text: `${state.bottomLine.slice(0, limit)}${marker}` };
    } else {
        delete data.footer;
    }

    if (state.mediaBuffer && state.mediaName) data.image = { url: `attachment://${state.mediaName}` };
    else if (state.mediaUrl) data.image = { url: state.mediaUrl };
    else delete data.image;

    return data;
}

function splitDynamicLogLine(line) {
    const match = String(line || '').match(/^(\s*(?:>\s*)?\*\*[^*]+:\*\*\s*)(.*)$/);
    return match ? { prefix: match[1], value: match[2] } : null;
}

function dynamicValues(value) {
    const values = [];
    let tokenized = String(value || '');

    // Member-specific possessive titles such as "feelfate's Balance" are one
    // reusable title shape. Preserve the live member name while letting the
    // administrator edit the fixed suffix, including capitalization.
    tokenized = tokenized.replace(/^([a-z0-9_.-]{2,32})(?='s\b)/i, match => {
        values.push(match);
        return '{dynamic}';
    });

    tokenized = tokenized.replace(
        /<t:\d+(?::[tTdDfFR])?>|<@!?\d+>|<@&\d+>|<#\d+>|<a?:[^:>]+:\d+>|https?:\/\/\S+|\$[\d,.]+|\b\d{1,3}(?:\.\d+)?%\b|\b\d{17,20}\b|\b\d+(?:\.\d+)?\b|@[a-z0-9_.-]{2,32}(?:#\d{4})?/gi,
        match => {
            values.push(match);
            return '{dynamic}';
        },
    );
    return { tokenized, values };
}

function mergeDynamicTemplateText(sourceText, editedText, peerText) {
    const source = dynamicValues(sourceText);
    const edited = dynamicValues(editedText);
    const peer = dynamicValues(peerText);
    const placeholders = edited.tokenized.match(/\{dynamic\}/gi) || [];

    // No dynamic slot was kept in the edited text: that is an explicit title/
    // text change, so use it as-is.
    if (!placeholders.length) return String(editedText || '');
    if (source.values.length !== peer.values.length || placeholders.length !== peer.values.length) {
        return String(editedText || '');
    }

    let index = 0;
    return edited.tokenized.replace(/\{dynamic\}/gi, () => peer.values[index++] || '{dynamic}');
}

function mergeTemplateDescription(sourceDescription, editedDescription, peerDescription) {
    const sourceLines = String(sourceDescription || '').split('\n');
    const editedLines = String(editedDescription || '').split('\n');
    const peerLines = String(peerDescription || '').split('\n');
    const maxLength = Math.max(sourceLines.length, editedLines.length, peerLines.length);
    const result = [];

    for (let index = 0; index < maxLength; index += 1) {
        const source = sourceLines[index] ?? '';
        const edited = editedLines[index] ?? source;
        const peer = peerLines[index] ?? source;
        const sourceDynamic = splitDynamicLogLine(source);
        const editedDynamic = splitDynamicLogLine(edited);
        const peerDynamic = splitDynamicLogLine(peer);

        if (sourceDynamic && editedDynamic && peerDynamic) {
            result.push(`${editedDynamic.prefix}${peerDynamic.value}`);
        } else if (dynamicValues(source).values.length && dynamicValues(source).values.length === dynamicValues(peer).values.length) {
            result.push(mergeDynamicTemplateText(source, edited, peer));
        } else if (peer === source || index >= peerLines.length) {
            result.push(edited);
        } else {
            result.push(peer);
        }
    }

    return result.join('\n').slice(0, 4096);
}

function applyStateToTemplatePeer(state, peerData, savedData, mediaChanges) {
    const target = state.modifyTarget;
    const source = target?.sourceEmbedData || {};
    const data = { ...peerData };

    if (target?.templateKind === 'content') {
        if (peerData.title) data.title = peerData.title;
        else if (target.catalogTitle) data.title = String(target.catalogTitle).slice(0, 256);
    } else if (state.title) data.title = mergeDynamicTemplateText(source.title, state.title, peerData.title).slice(0, 256);
    else delete data.title;

    const staticPanel = !/(?:\blog$|^ticket\b|^report\b|^(?:success|failed|error|warning|information|invalid|expired)$)/i.test(String(source.title || ''))
        && !/\{dynamic\}|<[@#]|<t:/i.test(String(source.description || ''));
    if (state.message) data.description = staticPanel ? normalizeManualIndent(state.message).slice(0, 4096) : mergeTemplateDescription(source.description, state.message, peerData.description);
    else delete data.description;

    if (Array.isArray(state.embedFields)) {
        data.fields = state.embedFields.map((field, index) => ({
            name: mergeDynamicTemplateText(source.fields?.[index]?.name, field.name, peerData.fields?.[index]?.name).slice(0, 256),
            value: normalizeManualIndent(mergeDynamicTemplateText(source.fields?.[index]?.value, field.value, peerData.fields?.[index]?.value)).slice(0, 1024),
            inline: Boolean(field.inline),
        }));
        if (!data.fields.length) delete data.fields;
    }
    data.color = state.sideColor;

    if (mediaChanges.thumbnailChanged) {
        if (savedData.thumbnail?.url) data.thumbnail = { ...savedData.thumbnail };
        else delete data.thumbnail;
    }

    if (state.bottomLine) {
        const marker = peerData.footer?.text?.endsWith(MESSAGE_BUILDER_FOOTER_MARKER) ? MESSAGE_BUILDER_FOOTER_MARKER : '';
        const limit = marker ? 2047 : 2048;
        data.footer = { ...(data.footer || {}), text: `${state.bottomLine.slice(0, limit)}${marker}` };
    } else {
        delete data.footer;
    }

    if (mediaChanges.imageChanged) {
        if (savedData.image?.url) data.image = { ...savedData.image };
        else delete data.image;
    }

    return data;
}

function mediaChangeState(sourceData, savedData) {
    const sourceThumbnail = sourceData?.thumbnail?.url || null;
    const savedThumbnail = savedData?.thumbnail?.url || null;
    const sourceImage = sourceData?.image?.url || null;
    const savedImage = savedData?.image?.url || null;

    return {
        thumbnailChanged: sourceThumbnail !== savedThumbnail,
        imageChanged: sourceImage !== savedImage,
    };
}

const templatePeerUpdateJobs = new Map();

function snapshotTemplatePeerState(state, target, sourceData) {
    return {
        title: state.title,
        message: state.message,
        embedFields: Array.isArray(state.embedFields) ? state.embedFields.map(field => ({ ...field })) : undefined,
        sideColor: state.sideColor,
        bottomLine: state.bottomLine,
        modifyTarget: {
            ...target,
            sourceEmbedData: sourceData,
        },
    };
}

async function updateMatchingTemplatePeers(guild, stateSnapshot, targetSnapshot, current, mediaChanges) {
    const records = await getEmbedRegistry(guild.id);
    const channelRecords = records.filter(record =>
        String(record.channelId) === String(targetSnapshot.channelId),
    );
    const groups = new Map();
    for (const record of channelRecords) {
        const physicalChannelId = String(record.backingChannelId || record.channelId);
        const key = `${physicalChannelId}:${String(record.messageId)}`;
        if (!groups.has(key)) groups.set(key, { physicalChannelId, messageId: String(record.messageId), records: [] });
        groups.get(key).records.push(record);
    }

    const directEdits = [];
    const fallbackRecords = [];
    const targetPhysicalChannelId = String(targetSnapshot.backingChannelId || targetSnapshot.channelId);

    for (const group of groups.values()) {
        const channel = guild.channels.cache.get(group.physicalChannelId)
            || await guild.channels.fetch(group.physicalChannelId).catch(() => null);
        const ordered = [...group.records].sort((a, b) => Number(a.embedIndex || 0) - Number(b.embedIndex || 0));
        const isTargetRecord = record =>
            group.physicalChannelId === targetPhysicalChannelId
            && String(record.messageId) === String(targetSnapshot.messageId)
            && Number(record.embedIndex || 0) === Number(targetSnapshot.embedIndex || 0);

        if (!channel?.messages?.edit) {
            fallbackRecords.push(...ordered.filter(record => !isTargetRecord(record)));
            continue;
        }

        const maxIndex = ordered.reduce((max, record) => Math.max(max, Number(record.embedIndex || 0)), -1);
        const snapshots = new Array(maxIndex + 1).fill(null);

        for (const record of ordered) {
            const index = Number(record.embedIndex || 0);
            snapshots[index] = isTargetRecord(record) ? current : getEmbedRegistrySnapshot(record);
        }

        const complete = snapshots.length > 0 && snapshots.every(Boolean);
        if (!complete) {
            fallbackRecords.push(...ordered.filter(record => !isTargetRecord(record)));
            continue;
        }

        let changed = false;
        const embeds = snapshots.map((peerData, embedIndex) => {
            const record = ordered.find(item => Number(item.embedIndex || 0) === embedIndex);
            const isTarget = Boolean(record && isTargetRecord(record));
            if (isTarget || !record) return new EmbedBuilder(peerData);

            const peerIdentity = templateIdentity(targetSnapshot.channelId, peerData);
            if (peerIdentity !== targetSnapshot.templateTitle) return new EmbedBuilder(peerData);

            changed = true;
            return new EmbedBuilder(applyStateToTemplatePeer(stateSnapshot, peerData, current, mediaChanges));
        });

        if (changed) directEdits.push({ channel, messageId: group.messageId, embeds });
    }

    const directJob = Promise.all(directEdits.map(async ({ channel, messageId, embeds }) => {
        const peerEdited = await channel.messages.edit(messageId, { embeds }).catch(error => {
            logger.error('Failed to directly update matching log template embed:', error);
            return null;
        });
        if (!peerEdited) return false;

        void registerCloudyEmbedMessage(peerEdited, 'modified-template')
            .catch(error => logger.error('Failed to refresh directly modified template registry:', error));
        return true;
    }));

    const resolvedPeers = await Promise.all(fallbackRecords.map(record =>
        resolveEmbedRegistryRecord(guild, record).catch(() => null),
    ));

    const fallbackEdits = [];
    for (const resolved of resolvedPeers) {
        if (!resolved) continue;

        const { record } = resolved;
        const peerData = resolved.embed.toJSON();
        const peerIdentity = templateIdentity(targetSnapshot.channelId, peerData);
        if (peerIdentity !== targetSnapshot.templateTitle) continue;

        const peerIndex = Number(record.embedIndex || 0);
        const peerEmbeds = resolved.message.embeds.map((embed, embedIndex) =>
            embedIndex === peerIndex
                ? new EmbedBuilder(applyStateToTemplatePeer(stateSnapshot, peerData, current, mediaChanges))
                : new EmbedBuilder(embed.toJSON()),
        );
        fallbackEdits.push({ resolved, peerEmbeds });
    }

    const fallbackJob = Promise.all(fallbackEdits.map(async ({ resolved, peerEmbeds }) => {
        const peerEdited = await resolved.message.edit({ embeds: peerEmbeds }).catch(error => {
            logger.error('Failed to update matching log template embed:', error);
            return null;
        });
        if (!peerEdited) return false;

        void registerCloudyEmbedMessage(peerEdited, 'modified-template')
            .catch(error => logger.error('Failed to refresh modified template registry:', error));
        return true;
    }));

    const [directResults, fallbackResults] = await Promise.all([directJob, fallbackJob]);
    return [...directResults, ...fallbackResults].filter(Boolean).length;
}

function queueMatchingTemplatePeerUpdate(guild, stateSnapshot, targetSnapshot, current, mediaChanges) {
    const key = `${guild.id}:${targetSnapshot.channelId}:${targetSnapshot.templateTitle || ''}`;
    const request = { guild, stateSnapshot, targetSnapshot, current, mediaChanges };
    const existing = templatePeerUpdateJobs.get(key);

    if (existing) {
        existing.pending = request;
        return;
    }

    const entry = { pending: request };
    templatePeerUpdateJobs.set(key, entry);

    const run = async () => {
        while (entry.pending) {
            const next = entry.pending;
            entry.pending = null;

            try {
                const updatedCount = await updateMatchingTemplatePeers(
                    next.guild,
                    next.stateSnapshot,
                    next.targetSnapshot,
                    next.current,
                    next.mediaChanges,
                );
                logger.debug(`Updated ${updatedCount} matching historical log embed(s) in background.`);
            } catch (error) {
                logger.error('Failed to update matching historical log embeds in background:', error);
            }
        }
    };

    void run().finally(() => {
        if (templatePeerUpdateJobs.get(key) === entry) templatePeerUpdateJobs.delete(key);
    });
}

export async function saveModifiedEmbed(guild, state) {
    const { flushPendingEmbedEditorUpdates } = await import('./embedColorPickerSessionService.js');
    await flushPendingEmbedEditorUpdates(state.colorSessionToken);
    const liveState = state;
    state = { ...state, embedFields: state.embedFields?.map(field => ({ ...field })) };
    const target = state.modifyTarget;
    if (!guild || !target) return { ok: false, reason: 'missing-target' };

    if (target.detached && target.source === 'embed-builder') {
        const current = applyStateToExistingEmbed(state);
        if (getEmbedsTextLength([current]) > DISCORD_EMBED_TOTAL_TEXT_LIMIT) {
            return { ok: false, reason: 'embed-too-large' };
        }

        const persisted = await updateDetachedEmbedRegistrySnapshot(guild.id, target, current);
        if (!persisted) return { ok: false, reason: 'persistence-failed' };

        state.modifyTarget.sourceEmbedData = current;
        state.modifyTarget.previewSourceData = { ...current };
        state.modifyTarget.cachedMessage = null;
        return {
            ok: true,
            channel: 'Saved templates',
            message: null,
            updatedCount: 1,
            detached: true,
        };
    }

    const backingChannelId = String(target.backingChannelId || target.channelId);
    const cachedMessage = target.cachedMessage
        && String(target.cachedMessage.id) === String(target.messageId)
        && target.cachedMessage.author?.id === guild.client.user?.id
        ? target.cachedMessage
        : null;
    const channel = cachedMessage?.channel
        || guild.channels.cache.get(backingChannelId)
        || await guild.channels.fetch(backingChannelId).catch(() => null);
    if (!cachedMessage && !channel?.messages?.fetch) return { ok: false, reason: 'channel-missing' };

    const message = cachedMessage || await channel.messages.fetch(target.messageId).catch(() => null);
    if (!message || message.author?.id !== guild.client.user?.id) return { ok: false, reason: 'message-missing' };
    // Public command responses are editable bot messages. Only temporary
    // Builder panels and private responses must be excluded from Save.
    if (message.flags?.has?.(MessageFlags.Ephemeral) || isBuilderSessionMessage(message)) {
        return { ok: false, reason: 'control-message' };
    }

    const index = Number(target.embedIndex || 0);
    if (!message.embeds?.[index]) return { ok: false, reason: 'embed-missing' };

    const sourceData = { ...(target.sourceEmbedData || {}) };
    const embeds = message.embeds.map((embed, embedIndex) =>
        embedIndex === index ? applyStateToExistingEmbed(state) : embed.toJSON(),
    );

    if (getEmbedsTextLength(embeds) > DISCORD_EMBED_TOTAL_TEXT_LIMIT) {
        return { ok: false, reason: 'embed-too-large' };
    }

    const payload = { embeds };
    if (state.componentsDirty) payload.components = getBuilderMessageComponents(state);
    if (state.mediaBuffer && state.mediaName) payload.files = [{ attachment: state.mediaBuffer, name: state.mediaName }];

    // Catalog identity is internal; it must never become a public embed author.
    if (target.source !== 'system-catalog' && String(message.content || '').trim() !== 'System & error embed templates') {
        for (const embed of payload.embeds) {
            if (/^Cloudy template key:/i.test(embed.author?.name || '')) delete embed.author;
        }
    }
    activeEmbedManagerSaves.add(String(message.id));
    const edited = await message.edit(payload).catch(error => {
        logger.error('Failed to save modified embed:', error);
        return null;
    });
    const releaseSaveGuard = setTimeout(() => activeEmbedManagerSaves.delete(String(message.id)), 2_000);
    releaseSaveGuard.unref?.();
    if (!edited) return { ok: false, reason: 'edit-failed' };
    if (state.componentsDirty) {
        state.componentRows = getBuilderMessageComponents(state);
        state.componentRowsSourceMessageId = String(edited.id);
        state.componentsDirty = false;
        if (liveState.modifyTarget === target) {
            liveState.componentRows = state.componentRows;
            liveState.componentRowsSourceMessageId = state.componentRowsSourceMessageId;
            liveState.componentsDirty = false;
        }
    }

    const current = edited.embeds?.[index]?.toJSON?.() || applyStateToExistingEmbed(state);
    const mediaChanges = mediaChangeState(sourceData, current);
    let updatedCount = 1;

    if (target.templateMode) {
        const sourceRule = getTemplateRuleByKey(target.channelId, target.templateTitle)
            || getTemplateRule(target.channelId, sourceData.title || target.templateTitle);
        const aliases = [
            target.templateTitle,
            stableSystemTemplateKey(sourceData),
            target.templateSourceData?.title,
            target.catalogTitle,
            sourceData.title,
            current.title,
            sourceRule?.label,
        ].filter(Boolean);
        const gameContext = curatedGameTemplateContext(target.templateTitle);
        if (gameContext) {
            primeSystemEmbedTemplateData(target.templateTitle, gameContext, current);
        }

        // The selected embed is already saved above. Persist the reusable
        // template without holding the Save interaction open on a DB roundtrip.
        // saveEmbedTemplateDecoration primes an in-memory overlay immediately,
        // so the next game/log output cannot briefly fall back to blue/default.
        const templateSaved = await saveEmbedTemplateDecoration(
            guild.id,
            target.channelId,
            aliases,
            current,
            {
                sharedScope: true,
                canonicalIdentity: target.templateTitle || templateIdentity(target.channelId, sourceData),
                // Ticket fields contain event data and must never be replaced
                // by the fixed examples shown in the durable catalog master.
                baseEmbedData: target.previewSourceData || target.sourceEmbedData,
                editedEmbedData: { description: state.message || undefined, fields: state.embedFields || [] },
                applyFields: true,
                preserveRuntimeFieldValues: String(target.templateTitle || '').startsWith('ticket-log:'),
                applyThumbnail: mediaChanges.thumbnailChanged,
                applyImage: mediaChanges.imageChanged,
            },
        );
        if (!templateSaved) {
            logger.error('Failed to persist saved embed template before confirming Builder Save.');
            return { ok: false, reason: 'persistence-failed' };
        }

        if (target.source === 'system-catalog') {
            // Keep the catalog cache in sync in the same tick as Save. Gateway
            // MessageUpdate events arrive later and previously caused a race
            // where the first new game used the old blue template.
            primeSystemEmbedCatalogMessage(edited);
            await syncSystemEmbedCatalogMessage(edited)
                .catch(error => logger.error('Failed to sync saved system embed template:', error));
        }

        if (String(target.templateTitle || '') === 'ticket-main') {
            void import('./ticketUiService.js')
                .then(({ syncCloudyTicketMessage }) => Promise.all(
                    [...guild.channels.cache.values()]
                        .filter(channel => /ticket-\d+/i.test(String(channel?.name || '')) && channel?.messages?.fetch)
                        .map(channel => syncCloudyTicketMessage(channel)),
                ))
                .catch(error => logger.error('Failed to refresh active ticket embeds after template save:', error));
        }

        const targetSnapshot = {
            ...target,
            sourceEmbedData: sourceData,
            templateTitle: target.templateTitle,
        };
        const stateSnapshot = snapshotTemplatePeerState(state, targetSnapshot, sourceData);
        queueMatchingTemplatePeerUpdate(guild, stateSnapshot, targetSnapshot, current, mediaChanges);
    }

    state.modifyTarget.sourceEmbedData = current;
    if (state.modifyTarget.previewSourceData) {
        const nextPreview = { ...state.modifyTarget.previewSourceData };
        if (state.title) nextPreview.title = state.title;
        else delete nextPreview.title;
        if (state.message) nextPreview.description = state.message;
        else delete nextPreview.description;
        nextPreview.fields = Array.isArray(state.embedFields)
            ? state.embedFields.map(field => ({ ...field }))
            : [];
        state.modifyTarget.previewSourceData = nextPreview;
    }
    state.modifyTarget.cachedMessage = edited;
    if (!target.templateMode) {
        state.modifyTarget.templateTitle = templateIdentity(target.channelId, current);
    }
    const registrySource = target.source === 'embed-builder'
        ? 'embed-builder'
        : (target.templateMode ? 'modified-template' : 'modified');
    const registered = await registerCloudyEmbedMessage(edited, registrySource, { manualSave: true, manualSaveIndex: index })
        .catch(error => {
            logger.error('Failed to refresh modified embed registry:', error);
            return false;
        });

    if (!registered) return { ok: false, reason: 'persistence-failed' };
    const displayChannel = guild.channels.cache.get(target.channelId) || channel;
    return { ok: true, channel: displayChannel, message: edited, updatedCount };
}

