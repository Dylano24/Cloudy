import { EmbedBuilder } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { getTraceContext, logger } from '../utils/logger.js';
import { discoverEmbedDefinitions } from './embedDefinitionDiscoveryService.js';
import { migrateCloudyLogoEmbedData } from './cloudyLogoService.js';
import { stripBlackjackCardsRemaining } from '../utils/blackjackEmbedPresentation.js';
import { getGuildConfig } from './config/guildConfig.js';

const CATALOG_PREFIX = 'cloudy:system-embed-catalog:';
const CATALOG_CONTENT = 'System & error embed templates';
const MAX_EMBEDS_PER_MESSAGE = 10;
const TEMPLATE_KEY_PREFIX = 'Cloudy template key:';
const TEMPLATE_CONTEXT_SEPARATOR = ' || Cloudy context:';
const TEMPLATE_KIND_SEPARATOR = ' || Cloudy kind:';

const contexts = new Map();
const templateCache = new Map();
const catalogEntries = new Set();
const pendingTemplates = new Map();
let flushTimer = null;
let discoveryPromise = null;

const INTERNAL_TEMPLATE_TITLES = new Set([
  'message builder',
  'modify embed',
  'embed loaded',
  'changes saved',
  'could not load embeds',
  '(use the buttons below to create your message)',
  'use the buttons below to create your message',
]);

const DEFAULT_TEMPLATES = [
  { key: 'wrong channel', context: 'gambling', kind: 'embed', title: 'Wrong channel', description: 'This command can only be used in the dedicated channel. Please use {dynamic} to play.', color: 0xED4245 },
  { key: 'not enough money', context: 'gambling', kind: 'embed', title: 'Not enough money', description: 'You only have {dynamic} cash, but you are trying to bet {dynamic}.', color: 0xED4245 },
  { key: 'invalid input', context: 'gambling', kind: 'embed', title: 'Invalid Input', description: 'Please check your input and try again.', color: 0xED4245 },
  { key: 'invalid code', context: 'botlog', kind: 'embed', title: 'Invalid code', description: 'That code is invalid or no longer available.', color: 0xED4245 },
  { key: 'permission denied', context: 'botlog', kind: 'embed', title: 'Permission Denied', description: "You don't have permission to do that.", color: 0xED4245 },
  { key: 'configuration error', context: 'botlog', kind: 'embed', title: 'Configuration Error', description: 'This feature is not set up yet. Ask a server administrator to configure it.', color: 0xED4245 },
  { key: 'database error', context: 'botlog', kind: 'embed', title: 'Database Error', description: 'Something went wrong while saving data. Please try again in a moment.', color: 0xED4245 },
  { key: 'network error', context: 'botlog', kind: 'embed', title: 'Network Error', description: 'I could not reach an external service. Please try again in a moment.', color: 0xED4245 },
  { key: 'discord api error', context: 'botlog', kind: 'embed', title: 'Discord API Error', description: 'Discord rejected that request. Please try again in a moment.', color: 0xED4245 },
  { key: 'input error', context: 'botlog', kind: 'embed', title: 'Input Error', description: 'There was a problem with your request. Check your input and try again.', color: 0xED4245 },
  { key: 'too fast', context: 'botlog', kind: 'embed', title: 'Too Fast', description: "You're doing that too quickly. Wait a moment and try again.", color: 0xFEE75C },
  { key: 'something went wrong', context: 'botlog', kind: 'embed', title: 'Something Went Wrong', description: 'Something went wrong. Please try again in a moment.', color: 0xED4245 },
];

// Deliberate Builder masters, never captured runtime ticket messages. Their
// backing messages live in the private catalog, so purging a public ticket log
// channel cannot remove these lifecycle templates from the Builder.
export const TICKET_LOG_CATALOG_TEMPLATES = [
  { key: 'ticket-log:open', context: 'ticket-logs/open', title: 'Ticket created', color: 0xFFFFFF, fields: [{ name: 'Ticket', value: '#123', inline: true }, { name: 'Creator', value: '<@123456789012345678>', inline: true }] },
  { key: 'ticket-log:close', context: 'ticket-logs/close', title: 'Ticket closed', color: 0xFF7A00, fields: [{ name: 'Ticket', value: '#123', inline: true }, { name: 'Closed by', value: '<@123456789012345678>', inline: true }] },
  { key: 'ticket-log:delete', context: 'ticket-logs/delete', title: 'Ticket deleted', color: 0xED4245, fields: [{ name: 'Ticket', value: '#123', inline: true }, { name: 'Deleted by', value: '<@123456789012345678>', inline: true }] },
  { key: 'ticket-log:claim', context: 'ticket-logs/claim', title: 'Ticket claimed', color: 0x57F287, fields: [{ name: 'Ticket', value: '#123', inline: true }, { name: 'Claimed by', value: '<@123456789012345678>', inline: true }] },
  { key: 'ticket-log:unclaim', context: 'ticket-logs/unclaim', title: 'Ticket unclaimed', color: 0x000000, fields: [{ name: 'Ticket', value: '#123', inline: true }, { name: 'Unclaimed by', value: '<@123456789012345678>', inline: true }] },
  { key: 'ticket-log:priority', context: 'ticket-logs/priority', title: 'Priority updated', color: 0xFF1493, fields: [{ name: 'Ticket', value: '#123', inline: true }, { name: 'Priority', value: 'Urgent', inline: true }, { name: 'Updated by', value: '<@123456789012345678>', inline: true }] },
  { key: 'ticket-log:pin', context: 'ticket-logs/pin', title: 'Ticket pinned', color: 0x8A2BE2, fields: [{ name: 'Ticket', value: '#123', inline: true }, { name: 'Pinned by', value: '<@123456789012345678>', inline: true }] },
  { key: 'ticket-log:unpin', context: 'ticket-logs/unpin', title: 'Ticket unpinned', color: 0x95A5A6, fields: [{ name: 'Ticket', value: '#123', inline: true }, { name: 'Unpinned by', value: '<@123456789012345678>', inline: true }] },
  { key: 'ticket-log:transcript', context: 'ticket-transcripts/transcript', title: 'Transcript generated', color: 0xFFFFFF, fields: [{ name: 'Ticket', value: '#123', inline: true }, { name: 'Creator', value: '<@123456789012345678>', inline: true }] },
  { key: 'ticket-log:feedback', context: 'ticket-logs/feedback', title: '⭐ Feedback received', color: 0x57F287, fields: [{ name: 'Ticket', value: '#123', inline: true }, { name: 'Rating', value: '⭐⭐⭐⭐⭐', inline: true }] },
];

const BLACKJACK_RESULT_STATES = new Set([
  'bust',
  'blackjack',
  'win',
  'push',
  'loss',
  'expired',
]);

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isTicketContext(context) {
  return /^tickets(?:\/|$)/.test(normalize(context));
}

function isValidBlackjackResultSlug(value) {
  const parts = normalize(value).split('-').filter(Boolean);
  return parts.length >= 1
    && parts.length <= 2
    && parts.every(part => BLACKJACK_RESULT_STATES.has(part));
}

export function isEditableSystemCatalogTemplate(key, context = null) {
  const normalizedKey = normalize(key);
  const normalizedContext = normalize(context);
  if (!normalizedKey || isTicketContext(normalizedContext)) return false;
  if (!normalizedKey.startsWith('game:')) return true;

  if (normalizedContext === 'gambling/roulette') {
    return normalizedKey === 'game:roulette:won' || normalizedKey === 'game:roulette:lost';
  }
  if (normalizedContext === 'gambling/baccarat') {
    return normalizedKey === 'game:baccarat:bet' || normalizedKey === 'game:baccarat:result';
  }
  if (normalizedContext === 'gambling/blackjack') {
    if (normalizedKey === 'game:blackjack:bet') return true;
    const prefix = 'game:blackjack:result:';
    return normalizedKey.startsWith(prefix)
      && isValidBlackjackResultSlug(normalizedKey.slice(prefix.length));
  }
  return false;
}

function compactName(value) {
  return normalize(value).replace(/[^a-z0-9]/g, '');
}

function cloneData(value) {
  const data = value?.toJSON ? value.toJSON() : { ...(value || {}) };
  return migrateCloudyLogoEmbedData(data).data || data;
}

function storageKey(guildId) {
  return `${CATALOG_PREFIX}${guildId}`;
}

function shortHash(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function dynamicParts(value = '') {
  const values = [];
  const sentinel = '\u0000CLOUDY_DYNAMIC\u0000';
  let text = String(value || '').replace(/\{dynamic\}/gi, sentinel);
  text = text.replace(
    /<t:\d+(?::[tTdDfFR])?>|<@!?\d+>|<@&\d+>|<#\d+>|<a?:[^:>]+:\d+>|https?:\/\/\S+|\$[\d,.]+|\b\d{1,3}(?:\.\d+)?%\b|\b\d{17,20}\b|\b(?:red|black|green|even|odd|player|banker|tie)\b|\b\d+(?:\.\d+)?\b/gi,
    match => {
      values.push(match);
      return '{dynamic}';
    },
  );
  text = text.replaceAll(sentinel, '{dynamic}');
  return {
    pattern: normalize(text),
    tokenized: text,
    values,
  };
}

function renderDynamic(template, runtime, { fallbackToRuntimeOnMismatch = false } = {}) {
  const source = String(runtime || '');
  const templateSource = String(template || '');
  const runtimeParts = dynamicParts(source);
  const templateParts = dynamicParts(templateSource);
  const placeholders = templateParts.tokenized.match(/\{dynamic\}/gi) || [];

  if (!placeholders.length) return templateSource;
  if (fallbackToRuntimeOnMismatch && runtimeParts.values.length !== placeholders.length) return source;

  let runtimeIndex = 0;
  let templateIndex = 0;
  const rendered = templateParts.tokenized.replace(/\{dynamic\}/gi, () => {
    const runtimeValue = runtimeParts.values[runtimeIndex++];
    const fallbackValue = templateParts.values[templateIndex++];
    return runtimeValue ?? fallbackValue ?? '{dynamic}';
  });

  return fallbackToRuntimeOnMismatch && /\{dynamic\}/i.test(rendered) ? source : rendered;
}

function responseSignature(kind, title = '', description = '') {
  const titlePattern = dynamicParts(title).pattern;
  const descriptionPattern = dynamicParts(description).pattern;
  return `${kind}:${shortHash(`${titlePattern}\n${descriptionPattern}`)}`;
}

function canonicalBlackjackResult(value) {
  const result = normalize(value).replace(/^result\s*:\s*/, '');
  const outcomes = result.split(/\s*\/\s*/).map(item => normalize(item)).filter(Boolean);
  if (!outcomes.length || outcomes.length > 2 || outcomes.some(item => !BLACKJACK_RESULT_STATES.has(item))) {
    return '';
  }
  return outcomes.join('-');
}

// Game messages change their money, cards and text every time. Their template
// key must describe the game state, never the example value that happened to
// be captured first. Curated games deliberately reject unknown/intermediate
// titles so live typing such as "Result: Bu" can never become a template.
export function getSystemEmbedTemplateKey(kind, title = '', description = '', context = null) {
  const normalizedKind = normalize(kind) || 'embed';
  const normalizedContext = normalize(context);
  const normalizedTitle = dynamicParts(title).pattern;

  if (normalizedKind === 'embed' && normalizedContext === 'gambling/roulette') {
    if (/^roulette\s*[—-]\s*you\s+won!?$/.test(normalizedTitle)) return 'game:roulette:won';
    if (/^roulette\s*[—-]\s*you\s+lost$/.test(normalizedTitle)) return 'game:roulette:lost';
    return '';
  }

  if (normalizedKind === 'embed' && normalizedContext === 'gambling/blackjack') {
    if (/^blackjack\s*[—-]\s*bet\b/.test(normalizedTitle)) return 'game:blackjack:bet';
    if (/^result\s*:/.test(normalizedTitle)) {
      const result = canonicalBlackjackResult(normalizedTitle);
      return result ? `game:blackjack:result:${result}` : '';
    }
    return '';
  }

  if (normalizedKind === 'embed' && normalizedContext === 'gambling/baccarat') {
    if (/^baccarat\s*[—-]\s*bet\b/.test(normalizedTitle)) return 'game:baccarat:bet';
    if (/^baccarat\s*[—-]\s*result\b/.test(normalizedTitle)) return 'game:baccarat:result';
    return '';
  }

  return responseSignature(normalizedKind, title, description);
}

function legacyCasinoTemplateKey(key, context) {
  const normalizedKey = normalize(key);
  const normalizedContext = normalize(context);
  const definitions = [
    ['gambling/roulette', 'Roulette — You won!', 'The wheel landed on {dynamic}\n**{dynamic} • {dynamic}**', 'game:roulette:won'],
    ['gambling/roulette', 'Roulette — You lost', 'The wheel landed on {dynamic}\n**{dynamic} • {dynamic}**', 'game:roulette:lost'],
    ['gambling/baccarat', 'Baccarat — Bet $100', 'Choose where to place your bet.', 'game:baccarat:bet'],
    ['gambling/baccarat', 'Baccarat — Result', 'Choose where to place your bet.', 'game:baccarat:result'],
    ['gambling/baccarat', 'Baccarat — Result', 'You chose **{dynamic}**. Winner: **{dynamic}**\nPayout: **{dynamic}**\nCash balance: **{dynamic}**', 'game:baccarat:result'],
  ];

  return definitions.find(([definitionContext, title, description]) =>
    normalizedContext === definitionContext
    && normalizedKey === responseSignature('embed', title, description),
  )?.[3] || null;
}

function isLegacyCatalogEdit(metadata, data) {
  const key = String(metadata?.key || '');
  if (!key.startsWith('embed:')) return false;
  return key !== responseSignature(metadata.kind, data?.title, data?.description);
}

function commandSlug(raw) {
  return normalize(raw)
    .replace(/^\/+/, '')
    .split(/[\s:|/]+/)[0]
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '');
}

function contextualize(feature, raw) {
  const slug = commandSlug(raw);
  return slug ? `${feature}/${slug}` : feature;
}

function inferContextHint(source = null) {
  const trace = getTraceContext();
  const raw = normalize(
    typeof source === 'string'
      ? source
      : source?.commandName || source?.customId || trace?.command || '',
  );

  if (/embed.?builder|simple_embed|message.?builder/.test(raw)) return null;
  if (/gambl|coin.?flip|slots?|blackjack|roulette|baccarat|fight|dice|roll|balance|daily|beg|crime|rob|fish|mine|pay|deposit|withdraw|inventory|economy|wallet|cash/.test(raw)) return contextualize('gambling', raw);
  if (/ticket|transcript|claim|reopen/.test(raw)) return contextualize('tickets', raw);
  if (/music|play|skip|pause|resume|queue|now.?playing|volume/.test(raw)) return contextualize('music', raw);
  if (/giveaway|gcreate|gend|gdelete|greroll/.test(raw)) return contextualize('giveaway', raw);
  if (/appeal/.test(raw)) return contextualize('ban-appeal', raw);
  if (/report/.test(raw)) return contextualize('reports', raw);
  if (/shop|purchase|subscription|store|buy|sell/.test(raw)) return contextualize('shop', raw);
  if (/welcome/.test(raw)) return contextualize('welcome', raw);
  if (/rules?/.test(raw)) return contextualize('rules', raw);
  if (/faq/.test(raw)) return contextualize('faq', raw);
  if (/staff.?review/.test(raw)) return contextualize('staff-reviews', raw);
  if (/ban|unban|kick|timeout|untimeout|warn|purge|clear|moderation|automod|security/.test(raw)) return contextualize('botlog', raw);

  const channelName = normalize(source?.channel?.name || '');
  if (channelName) return channelName;
  return raw ? contextualize('botlog', raw) : null;
}

function parentContext(context) {
  const value = normalize(context);
  return value.includes('/') ? value.split('/')[0] : null;
}

function cacheIdentity(key, context = null) {
  return `${normalize(context) || 'global'}::${normalize(key)}`;
}

function findCatalogChannel(guild) {
  const candidates = [...(guild?.channels?.cache?.values?.() || [])]
    .filter(channel => channel?.isTextBased?.() && channel?.isSendable?.())
    .map(channel => ({ channel, compact: compactName(channel.name) }))
    .filter(item => item.compact === 'botlog' || item.compact === 'botlogs' || item.compact.includes('botlog'))
    .sort((a, b) => (a.channel.position ?? 0) - (b.channel.position ?? 0));
  return candidates[0]?.channel || null;
}

function parseTemplateMetadata(embed) {
  const data = cloneData(embed);
  const authorName = String(data.author?.name || '');
  if (!authorName.toLowerCase().startsWith(TEMPLATE_KEY_PREFIX.toLowerCase())) {
    return { key: normalize(data.title), context: null, kind: 'embed' };
  }

  let metadata = authorName.slice(TEMPLATE_KEY_PREFIX.length).trim();
  let kind = 'embed';
  let context = null;

  const kindIndex = metadata.toLowerCase().indexOf(TEMPLATE_KIND_SEPARATOR.toLowerCase());
  if (kindIndex !== -1) {
    kind = normalize(metadata.slice(kindIndex + TEMPLATE_KIND_SEPARATOR.length)) || 'embed';
    metadata = metadata.slice(0, kindIndex);
  }

  const contextIndex = metadata.toLowerCase().indexOf(TEMPLATE_CONTEXT_SEPARATOR.toLowerCase());
  if (contextIndex !== -1) {
    context = normalize(metadata.slice(contextIndex + TEMPLATE_CONTEXT_SEPARATOR.length));
    metadata = metadata.slice(0, contextIndex);
  }

  return { key: normalize(metadata), context, kind };
}

function withStableKey(data, key, context = null, kind = 'embed') {
  const authorName = [
    `${TEMPLATE_KEY_PREFIX} ${normalize(key)}`,
    context ? `${TEMPLATE_CONTEXT_SEPARATOR} ${normalize(context)}` : '',
    `${TEMPLATE_KIND_SEPARATOR} ${normalize(kind) || 'embed'}`,
  ].join('').slice(0, 256);
  return {
    ...data,
    author: {
      ...(data.author || {}),
      name: authorName,
    },
  };
}

function isInternalTemplate(data) {
  const title = normalize(data?.title);
  if (!title || INTERNAL_TEMPLATE_TITLES.has(title)) return true;
  const authorName = String(data?.author?.name || '');
  return authorName.toLowerCase().startsWith(TEMPLATE_KEY_PREFIX.toLowerCase());
}

function rememberTemplate(key, data, context = null) {
  if (!key || !data || !isEditableSystemCatalogTemplate(key, context)) return;
  templateCache.set(cacheIdentity(key, context), cloneData(data));
}

function findTemplate(key, context) {
  if (!key) return null;
  const exact = normalize(context);
  const parent = parentContext(exact);
  return templateCache.get(cacheIdentity(key, exact))
    || (parent ? templateCache.get(cacheIdentity(key, parent)) : null)
    || templateCache.get(cacheIdentity(key, null))
    || null;
}

function rememberCatalogMessage(message) {
  for (const embed of message?.embeds || []) {
    const metadata = parseTemplateMetadata(embed);
    if (!metadata.key || !isEditableSystemCatalogTemplate(metadata.key, metadata.context)) continue;
    catalogEntries.add(cacheIdentity(metadata.key, metadata.context));
    rememberTemplate(metadata.key, embed, metadata.context);
  }
}

async function loadCatalogMessages(context) {
  const ids = await getFromDb(storageKey(context.guild.id), []);
  const messages = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const message = await context.channel.messages.fetch(id).catch(() => null);
    if (message) messages.push(message);
  }
  return messages;
}

async function saveCatalogIds(guildId, messages) {
  await setInDb(storageKey(guildId), messages.map(message => message.id));
}

async function registerCatalogMessages(messages) {
  if (!messages?.length) return;
  const { registerCloudyEmbedMessages } = await import('./embedRegistryService.js');
  await registerCloudyEmbedMessages(messages, 'system-catalog');
}

function friendlyPlainTitle(context, content) {
  const command = normalize(context).split('/')[1] || normalize(context).split('/')[0] || 'bot';
  const prefix = command ? command.charAt(0).toUpperCase() + command.slice(1) : 'Bot';
  const preview = String(content || '')
    .replace(/<a?:[^:>]+:\d+>/g, '')
    .replace(/\{dynamic\}/gi, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 65);
  return `${prefix} • ${preview || 'Message'}`.slice(0, 256);
}

function definitionToCatalog(definition) {
  const kind = normalize(definition.kind) === 'content' ? 'content' : 'embed';
  const context = normalize(definition.context) || 'botlog';
  const description = String(definition.description || definition.content || '').slice(0, 4096);
  const sourceTitle = String(definition.title || '').trim();
  const title = kind === 'content'
    ? String(definition.label || friendlyPlainTitle(context, description)).slice(0, 256)
    : (sourceTitle || 'Untitled embed').slice(0, 256);
  const key = definition.key
    || getSystemEmbedTemplateKey(kind, kind === 'embed' ? title : '', description, context);

  const fields = Array.isArray(definition.fields)
    ? definition.fields.filter(field => field?.name && field?.value).slice(0, 25).map(field => ({ ...field }))
    : undefined;

  return {
    key,
    context,
    kind,
    data: withStableKey({
      title,
      ...(description ? { description } : {}),
      color: Number.isInteger(definition.color) ? definition.color : 0x5865F2,
      ...(fields?.length ? { fields } : {}),
      ...(definition.footer?.text ? { footer: { ...definition.footer } } : {}),
      ...(definition.thumbnail?.url ? { thumbnail: { ...definition.thumbnail } } : {}),
      ...(definition.image?.url ? { image: { ...definition.image } } : {}),
    }, key, context, kind),
  };
}

function mergeCatalogShape(existingData, incomingData) {
  const existing = cloneData(existingData || {});
  const incoming = cloneData(incomingData || {});
  const next = { ...existing };

  if (!next.title && incoming.title) next.title = incoming.title;
  if (!next.description && incoming.description) next.description = incoming.description;
  if (!Number.isInteger(next.color) && Number.isInteger(incoming.color)) next.color = incoming.color;
  if (!next.footer?.text && incoming.footer?.text) next.footer = { ...incoming.footer };
  if (!next.thumbnail?.url && incoming.thumbnail?.url) next.thumbnail = { ...incoming.thumbnail };
  if (!next.image?.url && incoming.image?.url) next.image = { ...incoming.image };

  const currentFields = Array.isArray(next.fields) ? next.fields.map(field => ({ ...field })) : [];
  const incomingFields = Array.isArray(incoming.fields) ? incoming.fields : [];
  for (let index = currentFields.length; index < incomingFields.length; index += 1) {
    if (incomingFields[index]?.name && incomingFields[index]?.value) {
      currentFields.push({ ...incomingFields[index] });
    }
  }
  if (currentFields.length) next.fields = currentFields.slice(0, 25);

  if (!next.author?.name && incoming.author?.name) next.author = { ...incoming.author };
  return next;
}

function isBlackjackContext(context) {
  return normalize(context) === 'gambling/blackjack';
}

function catalogDataChanged(left, right) {
  return JSON.stringify(cloneData(left || {})) !== JSON.stringify(cloneData(right || {}));
}

function semanticCatalogKey(metadata, embed) {
  if (String(metadata.key || '').startsWith('game:')
    && isEditableSystemCatalogTemplate(metadata.key, metadata.context)) return metadata.key;
  const data = cloneData(embed);
  const canonical = getSystemEmbedTemplateKey(
    metadata.kind,
    data.title,
    data.description,
    metadata.context,
  );
  return String(canonical || '').startsWith('game:') ? canonical : metadata.key;
}

function catalogEntryIdentity(metadata, embed) {
  return cacheIdentity(semanticCatalogKey(metadata, embed), metadata.context);
}

function entryIdentity(entry) {
  const data = cloneData(entry.data);
  const canonical = getSystemEmbedTemplateKey(entry.kind, data.title, data.description, entry.context);
  const key = String(entry.key || '').startsWith('game:') && isEditableSystemCatalogTemplate(entry.key, entry.context)
    ? entry.key
    : (String(canonical || '').startsWith('game:') ? canonical : entry.key);
  return cacheIdentity(key, entry.context);
}

function findCatalogEntry(messages, entry) {
  const identity = entryIdentity(entry);
  for (const message of messages) {
    for (let index = 0; index < (message?.embeds?.length || 0); index += 1) {
      const metadata = parseTemplateMetadata(message.embeds[index]);
      if (
        cacheIdentity(metadata.key, metadata.context) === identity
        || catalogEntryIdentity(metadata, message.embeds[index]) === identity
      ) {
        return { message, index, embed: message.embeds[index], metadata };
      }
    }
  }
  return null;
}

async function appendCatalogEntry(context, entry, messages) {
  if (!entry?.key || !isEditableSystemCatalogTemplate(entry.key, entry.context)) return false;
  const identity = entryIdentity(entry);
  const existingLocation = findCatalogEntry(messages, entry);

  if (existingLocation) {
    // Catalog entries are the styling source for future games. Remove only
    // the retired Blackjack presentation line from legacy entries while
    // preserving their administrator-saved title, color, footer, media and
    // fields exactly as they are.
    const currentData = isBlackjackContext(entry.context)
      ? stripBlackjackCardsRemaining(existingLocation.embed)
      : cloneData(existingLocation.embed);
    const mergedData = withStableKey(
      mergeCatalogShape(currentData, entry.data),
      entry.key,
      entry.context,
      entry.kind,
    );
    if (!catalogDataChanged(currentData, mergedData)) {
      catalogEntries.add(identity);
      rememberTemplate(entry.key, currentData, entry.context);
      return false;
    }

    const embeds = existingLocation.message.embeds.map(embed => new EmbedBuilder(embed.toJSON()));
    embeds[existingLocation.index] = new EmbedBuilder(mergedData);
    const edited = await existingLocation.message.edit({ content: CATALOG_CONTENT, embeds }).catch(() => null);
    if (!edited) return false;

    catalogEntries.add(identity);
    rememberTemplate(entry.key, mergedData, entry.context);
    await registerCatalogMessages([edited]).catch(error => logger.warn(`Failed to register updated response catalog: ${error.message}`));
    return true;
  }

  let target = messages.at(-1) || null;
  let embeds = target ? target.embeds.map(embed => new EmbedBuilder(embed.toJSON())) : [];
  if (!target || embeds.length >= MAX_EMBEDS_PER_MESSAGE) {
    target = await context.channel.send({ content: CATALOG_CONTENT, embeds: [] }).catch(() => null);
    if (!target) return false;
    messages.push(target);
    embeds = [];
  }

  embeds.push(new EmbedBuilder(entry.data));
  const edited = await target.edit({ content: CATALOG_CONTENT, embeds }).catch(() => null);
  if (!edited) return false;

  catalogEntries.add(identity);
  rememberTemplate(entry.key, entry.data, entry.context);
  await saveCatalogIds(context.guild.id, messages);
  await registerCatalogMessages([edited]).catch(error => logger.warn(`Failed to register response catalog: ${error.message}`));
  return true;
}

function isCuratedCasinoContext(context) {
  return /^gambling\/(?:blackjack|baccarat|roulette)$/.test(normalize(context));
}

function catalogEntryTimestamp(location) {
  const date = Date.parse(
    location.message?.editedTimestamp
    || location.message?.createdTimestamp
    || location.message?.createdAt
    || 0,
  );
  return Number.isFinite(date) ? date : 0;
}

function catalogEntryPriority(location) {
  const stableKey = String(location.metadata?.key || '');
  return (stableKey.startsWith('game:') ? 1_000_000_000_000_000 : 0) + catalogEntryTimestamp(location);
}

// Old versions created a catalog record for every observed blackjack/baccarat
// value and also picked up parser noise such as "success" and "primary".
// Ticket runtime messages are not Embed Builder templates at all. Keep one
// canonical master per real game state and delete only internal catalog embeds
// (never player messages, ticket messages, or normal log history).
export async function cleanupSystemCatalogEntries(messages) {
  const groups = new Map();
  const removals = new Map();
  const rewrites = new Map();

  const markRemoval = (message, index) => {
    if (!removals.has(message.id)) removals.set(message.id, new Set());
    removals.get(message.id).add(index);
  };

  for (const message of messages) {
    for (let index = 0; index < (message?.embeds?.length || 0); index += 1) {
      const embed = message.embeds[index];
      const metadata = parseTemplateMetadata(embed);

      if (isTicketContext(metadata.context)) {
        markRemoval(message, index);
        continue;
      }
      if (!isCuratedCasinoContext(metadata.context)) continue;

      const data = cloneData(embed);
      const stableGameKey = String(metadata.key || '').startsWith('game:')
        && isEditableSystemCatalogTemplate(metadata.key, metadata.context)
        ? metadata.key
        : null;
      const canonicalKey = stableGameKey
        || legacyCasinoTemplateKey(metadata.key, metadata.context)
        || getSystemEmbedTemplateKey(
          metadata.kind,
          data.title,
          data.description,
          metadata.context,
        );

      // These were source-parser artifacts or transient live-title states, not
      // a real player-facing casino response. An invalid stable game key is
      // always junk; a legacy embed:* entry is preserved only when an admin
      // genuinely renamed it and it cannot be mapped to a canonical game state.
      if (!canonicalKey || !isEditableSystemCatalogTemplate(canonicalKey, metadata.context)) {
        if (!String(metadata.key || '').startsWith('game:') && isLegacyCatalogEdit(metadata, data)) continue;
        markRemoval(message, index);
        continue;
      }

      const identity = cacheIdentity(canonicalKey, metadata.context);
      if (!groups.has(identity)) groups.set(identity, []);
      groups.get(identity).push({ message, index, embed, metadata, canonicalKey });
    }
  }

  for (const entries of groups.values()) {
    const ordered = [...entries].sort((left, right) => catalogEntryPriority(right) - catalogEntryPriority(left));
    const winner = ordered[0];
    let merged = cloneData(winner.embed);

    for (const duplicate of ordered.slice(1)) {
      merged = mergeCatalogShape(merged, duplicate.embed);
      markRemoval(duplicate.message, duplicate.index);
    }

    const canonicalData = withStableKey(
      merged,
      winner.canonicalKey,
      winner.metadata.context,
      winner.metadata.kind,
    );
    if (!catalogDataChanged(winner.embed, canonicalData)) continue;
    if (!rewrites.has(winner.message.id)) rewrites.set(winner.message.id, new Map());
    rewrites.get(winner.message.id).set(winner.index, canonicalData);
  }

  if (!removals.size && !rewrites.size) return false;

  const nextMessages = [];
  for (const message of messages) {
    const removeIndexes = removals.get(message.id) || new Set();
    const replacements = rewrites.get(message.id) || new Map();
    const embeds = (message.embeds || [])
      .flatMap((embed, index) => {
        if (removeIndexes.has(index)) return [];
        return [new EmbedBuilder(replacements.get(index) || cloneData(embed))];
      });

    if (!embeds.length) {
      if (typeof message.delete === 'function') {
        await message.delete().catch(() => null);
      }
      continue;
    }

    const changed = removeIndexes.size > 0 || replacements.size > 0;
    if (!changed) {
      nextMessages.push(message);
      continue;
    }

    const edited = await message.edit({ content: CATALOG_CONTENT, embeds }).catch(() => null);
    nextMessages.push(edited || message);
  }

  messages.splice(0, messages.length, ...nextMessages);
  return true;
}

async function discoverStaticTemplates() {
  if (!discoveryPromise) {
    discoveryPromise = discoverEmbedDefinitions().catch(error => {
      logger.warn(`Embed builder source discovery failed: ${error.message}`);
      return [];
    });
  }
  return discoveryPromise;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingTemplates();
  }, 250);
  flushTimer.unref?.();
}

function queueRuntimeEntry(entry) {
  if (!entry?.key || !isEditableSystemCatalogTemplate(entry.key, entry.context)) return false;
  const identity = cacheIdentity(entry.key, entry.context);
  const pending = pendingTemplates.get(identity);
  if (pending) {
    const merged = mergeCatalogShape(pending.data, entry.data);
    pendingTemplates.set(identity, { ...pending, data: merged });
    return true;
  }

  if (catalogEntries.has(identity)) {
    const cached = findTemplate(entry.key, entry.context);
    const merged = mergeCatalogShape(cached || {}, entry.data);
    if (cached && !catalogDataChanged(cached, merged)) return false;
    pendingTemplates.set(identity, { ...entry, data: merged });
    scheduleFlush();
    return true;
  }

  pendingTemplates.set(identity, entry);
  scheduleFlush();
  return true;
}

export function registerDiscoveredEmbedDefinition(definition = {}) {
  const entry = definitionToCatalog(definition);
  if (!entry.key || isInternalTemplate(entry.data) || !isEditableSystemCatalogTemplate(entry.key, entry.context)) return false;
  return queueRuntimeEntry(entry);
}

export function captureSystemEmbedData(embedData, contextSource = null) {
  const sourceData = cloneData(embedData);
  const context = inferContextHint(contextSource);
  if (!context || isTicketContext(context)) return false;
  const data = isBlackjackContext(context)
    ? stripBlackjackCardsRemaining(sourceData)
    : sourceData;
  if (isInternalTemplate(data)) return false;
  const key = getSystemEmbedTemplateKey('embed', data.title, data.description, context);
  if (!key || !isEditableSystemCatalogTemplate(key, context)) return false;
  return queueRuntimeEntry({
    key,
    context,
    kind: 'embed',
    data: withStableKey(data, key, context, 'embed'),
  });
}

export function applyRuntimeEmbedTemplateData(embedData, contextSource = null) {
  const data = cloneData(embedData);
  if (isInternalTemplate(data)) return data;
  const context = inferContextHint(contextSource);
  if (isTicketContext(context)) return data;
  const specificKey = getSystemEmbedTemplateKey('embed', data.title, data.description, context);
  const titleKey = normalize(data.title);
  const template = (specificKey ? findTemplate(specificKey, context) : null) || findTemplate(titleKey, context);

  if (!template) {
    if (context && specificKey) captureSystemEmbedData(data, contextSource);
    return isBlackjackContext(context) ? stripBlackjackCardsRemaining(data) : data;
  }

  const next = { ...data };
  if (template.title) next.title = renderDynamic(template.title, data.title, { fallbackToRuntimeOnMismatch: true });
  if (template.description) next.description = renderDynamic(template.description, data.description, { fallbackToRuntimeOnMismatch: true });
  if (Number.isInteger(template.color)) next.color = template.color;

  if (Array.isArray(template.fields)) {
    const runtimeFields = Array.isArray(data.fields) ? data.fields : [];
    next.fields = runtimeFields.length
      ? runtimeFields.map((runtimeField, index) => {
        const templateField = template.fields[index];
        if (!templateField) return { ...runtimeField };
        return {
          ...runtimeField,
          name: templateField.name
            ? renderDynamic(templateField.name, runtimeField.name, { fallbackToRuntimeOnMismatch: true })
            : runtimeField.name,
          value: templateField.value
            ? renderDynamic(templateField.value, runtimeField.value, { fallbackToRuntimeOnMismatch: true })
            : runtimeField.value,
          inline: typeof templateField.inline === 'boolean' ? templateField.inline : runtimeField.inline,
        };
      })
      : template.fields.map(field => ({ ...field }));
  }

  if (template.footer?.text) {
    next.footer = {
      ...template.footer,
      text: renderDynamic(template.footer.text, data.footer?.text || template.footer.text, { fallbackToRuntimeOnMismatch: true }),
    };
  } else delete next.footer;

  if (template.thumbnail?.url) next.thumbnail = { ...template.thumbnail };
  else delete next.thumbnail;
  if (template.image?.url) next.image = { ...template.image };
  else delete next.image;
  return isBlackjackContext(context) ? stripBlackjackCardsRemaining(next) : next;
}

export function applySystemEmbedTemplate(embed) {
  if (!embed) return embed;
  return new EmbedBuilder(applyRuntimeEmbedTemplateData(embed));
}

function contentFromPayload(payload) {
  if (typeof payload === 'string') return payload;
  return typeof payload?.content === 'string' ? payload.content : null;
}

export function applyPlainResponseTemplate(payload, contextSource = null) {
  const content = contentFromPayload(payload);
  if (!content?.trim()) return payload;

  const context = inferContextHint(contextSource);
  if (!context || isTicketContext(context)) return payload;
  const key = responseSignature('content', '', content);
  const template = findTemplate(key, context);

  if (!template) {
    const entry = definitionToCatalog({ kind: 'content', context, content, key });
    queueRuntimeEntry(entry);
    return payload;
  }

  const replacement = renderDynamic(template.description || content, content, { fallbackToRuntimeOnMismatch: true });
  if (typeof payload === 'string') return replacement;
  return { ...payload, content: replacement };
}

export async function ensureSystemEmbedCatalogs(client) {
  const discoveredDefinitions = await discoverStaticTemplates();
  // Blackjack, baccarat and roulette are explicitly learned from their real
  // runtime shapes. Ticket runtime output is intentionally not an Embed
  // Builder template. This prevents parser/runtime noise from polluting the
  // reusable template list while keeping all other real system templates.
  const definitions = discoveredDefinitions.filter(definition =>
    !isCuratedCasinoContext(definition.context) && !isTicketContext(definition.context));
  let totalAdded = 0;

  for (const guild of client.guilds.cache.values()) {
    const channel = findCatalogChannel(guild);
    if (!channel?.messages?.fetch) {
      logger.warn(`[EMBED_BUILDER] No botlog channel found in guild ${guild.id}; response catalog cannot be indexed.`);
      continue;
    }

    // Warm configuration before registry placement so custom-named ticket log
    // destinations receive the virtual catalog records by configured ID.
    await getGuildConfig(client, guild.id).catch(() => null);
    const context = { guild, channel };
    contexts.set(guild.id, context);
    const messages = await loadCatalogMessages(context);
    await cleanupSystemCatalogEntries(messages);
    for (const message of messages) rememberCatalogMessage(message);

    const entries = [
      ...DEFAULT_TEMPLATES.map(definitionToCatalog),
      ...TICKET_LOG_CATALOG_TEMPLATES.map(definitionToCatalog),
      ...definitions.map(definitionToCatalog),
    ];

    for (const entry of entries) {
      if (await appendCatalogEntry(context, entry, messages)) totalAdded += 1;
    }

    await saveCatalogIds(guild.id, messages);
    await registerCatalogMessages(messages).catch(error => logger.warn(`Failed to register response catalog messages: ${error.message}`));
  }

  await flushPendingTemplates();
  logger.warn(`[EMBED_BUILDER] Response catalog ready: ${definitions.length} source definitions, ${totalAdded} newly indexed or enriched.`);
  return { definitions: definitions.length, added: totalAdded };
}

export function primeSystemEmbedCatalogMessage(message) {
  if (!message?.guildId || !message?.channelId || !message?.embeds?.length) return false;
  const context = contexts.get(message.guildId);
  if (!context || String(context.channel.id) !== String(message.channelId)) return false;

  rememberCatalogMessage(message);
  return true;
}

// Embed Builder can edit a reusable game template through either its catalog
// record or a real game message. Prime the canonical cache in the same tick as
// Save so the very next component update cannot reuse the previous styling.
export function primeSystemEmbedTemplateData(key, context, embedData) {
  const normalizedKey = normalize(key);
  const normalizedContext = normalize(context);
  if (!normalizedKey || !normalizedContext || !embedData
    || !isEditableSystemCatalogTemplate(normalizedKey, normalizedContext)) return false;

  const sourceData = cloneData(embedData);
  const data = isBlackjackContext(normalizedContext)
    ? stripBlackjackCardsRemaining(sourceData)
    : sourceData;
  rememberTemplate(normalizedKey, data, normalizedContext);
  catalogEntries.add(cacheIdentity(normalizedKey, normalizedContext));
  return true;
}

export async function syncSystemEmbedCatalogMessage(message) {
  if (!primeSystemEmbedCatalogMessage(message)) return false;

  const ids = await getFromDb(storageKey(message.guildId), []);
  if (!Array.isArray(ids) || !ids.includes(message.id)) return false;

  await registerCatalogMessages([message]).catch(error => logger.warn(`Failed to sync edited response template: ${error.message}`));
  return true;
}

async function flushPendingTemplates() {
  if (!pendingTemplates.size || !contexts.size) return;
  const queued = [...pendingTemplates.values()].filter(entry =>
    entry?.key && isEditableSystemCatalogTemplate(entry.key, entry.context));
  pendingTemplates.clear();

  for (const context of contexts.values()) {
    const messages = await loadCatalogMessages(context);
    await cleanupSystemCatalogEntries(messages);
    for (const message of messages) rememberCatalogMessage(message);
    for (const entry of queued) {
      await appendCatalogEntry(context, entry, messages).catch(error => {
        logger.warn(`Failed to append or enrich runtime response template: ${error.message}`);
      });
    }
    await saveCatalogIds(context.guild.id, messages);
  }
}
