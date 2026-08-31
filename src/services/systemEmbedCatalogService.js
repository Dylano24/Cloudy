import { EmbedBuilder } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { getTraceContext, logger } from '../utils/logger.js';
import { discoverEmbedDefinitions } from './embedDefinitionDiscoveryService.js';

const CATALOG_PREFIX = 'cloudy:system-embed-catalog:';
const EDITED_VARIANTS_PREFIX = 'cloudy:system-embed-edited-variants:';
const CATALOG_CONTENT = 'System & error embed templates';
const MAX_EMBEDS_PER_MESSAGE = 10;
const TEMPLATE_KEY_PREFIX = 'Cloudy template key:';
const TEMPLATE_CONTEXT_SEPARATOR = ' || Cloudy context:';
const TEMPLATE_VARIANT_SEPARATOR = ' || Cloudy variant:';
const DISCOVERY_EDGE = '\u2063';
const DISCOVERY_ZERO = '\u200B';
const DISCOVERY_ONE = '\u200C';
const INTERNAL_WRITE_TTL_MS = 5_000;

const contexts = new Map();
const templateCache = new Map();
const catalogEntries = new Set();
const pendingTemplates = new Map();
const editedVariants = new Map();
const internalCatalogWrites = new Map();
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
  { key: 'wrong channel', context: 'gambling', title: 'Wrong channel', description: 'This command can only be used in the dedicated channel. Please use {channel} to play.', color: 0xED4245 },
  { key: 'not enough money', context: 'gambling', title: 'Not enough money', description: 'You only have {current} cash, but you are trying to bet {required}.', color: 0xED4245 },
  { key: 'invalid input', context: 'gambling', title: 'Invalid Input', description: 'Please check your input and try again.', color: 0xED4245 },
  { key: 'invalid code', context: 'botlog', title: 'Invalid code', description: 'That code is invalid or no longer available.', color: 0xED4245 },
  { key: 'permission denied', context: 'botlog', title: 'Permission Denied', description: "You don't have permission to do that.", color: 0xED4245 },
  { key: 'configuration error', context: 'botlog', title: 'Configuration Error', description: 'This feature is not set up yet. Ask a server administrator to configure it.', color: 0xED4245 },
  { key: 'database error', context: 'botlog', title: 'Database Error', description: 'Something went wrong while saving data. Please try again in a moment.', color: 0xED4245 },
  { key: 'network error', context: 'botlog', title: 'Network Error', description: 'I could not reach an external service. Please try again in a moment.', color: 0xED4245 },
  { key: 'discord api error', context: 'botlog', title: 'Discord API Error', description: 'Discord rejected that request. Please try again in a moment.', color: 0xED4245 },
  { key: 'input error', context: 'botlog', title: 'Input Error', description: 'There was a problem with your request. Check your input and try again.', color: 0xED4245 },
  { key: 'too fast', context: 'botlog', title: 'Too Fast', description: "You're doing that too quickly. Wait a moment and try again.", color: 0xFEE75C },
  { key: 'something went wrong', context: 'botlog', title: 'Something Went Wrong', description: 'Something went wrong. Please try again in a moment.', color: 0xED4245 },
  { key: 'warning', context: 'botlog', title: 'Warning', description: 'A warning message from Cloudy.', color: 0xFEE75C },
  { key: 'information', context: 'botlog', title: 'Information', description: 'An information message from Cloudy.', color: 0x5865F2 },
  { key: 'success', context: 'botlog', title: 'Success', description: 'The action was completed successfully.', color: 0x57F287 },
  { key: 'notice', context: 'botlog', title: 'Notice', description: 'A notice from Cloudy.', color: 0x5865F2 },
  { key: 'error', context: 'botlog', title: 'Error', description: 'Something went wrong. Please try again.', color: 0xED4245 },
];

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function storageKey(guildId) {
  return `${CATALOG_PREFIX}${guildId}`;
}

function editedVariantsKey(guildId) {
  return `${EDITED_VARIANTS_PREFIX}${guildId}`;
}

function cloneData(embed) {
  return embed?.toJSON ? embed.toJSON() : { ...(embed || {}) };
}

function isInternalTemplate(data) {
  const title = normalize(data?.title);
  if (!title || INTERNAL_TEMPLATE_TITLES.has(title)) return true;
  const authorName = String(data?.author?.name || '');
  return authorName.toLowerCase().startsWith(TEMPLATE_KEY_PREFIX.toLowerCase());
}

function findCatalogChannel(guild) {
  return guild?.channels?.cache?.find(channel => {
    const name = normalize(channel?.name);
    return channel?.isTextBased?.() && channel?.isSendable?.()
      && (name === 'botlog' || name === 'bot-log' || name === 'bot-logs' || name.includes('botlog'));
  }) || null;
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

  if (/gambl|coin.?flip|slots?|blackjack|roulette|fight|dice|roll|balance|daily|beg|crime|rob|fish|mine|pay|deposit|withdraw|inventory|economy|wallet|cash/.test(raw)) return contextualize('gambling', raw);
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
  const normalized = normalize(context);
  if (!normalized.includes('/')) return null;
  return normalized.split('/')[0] || null;
}

function cacheIdentity(key, context = null) {
  return `${normalize(key)}::${normalize(context) || 'global'}`;
}

function catalogIdentity(key, context = null, variant = null) {
  return `${cacheIdentity(key, context)}::${normalize(variant) || 'primary'}`;
}

function parseTemplateMetadata(embed) {
  const data = cloneData(embed);
  const authorName = String(data.author?.name || '');
  if (!authorName.toLowerCase().startsWith(TEMPLATE_KEY_PREFIX.toLowerCase())) {
    return { key: normalize(stripDiscoverySuffix(data.title)), context: null, variant: null };
  }

  let metadata = authorName.slice(TEMPLATE_KEY_PREFIX.length).trim();
  let variant = null;
  let context = null;

  const variantIndex = metadata.toLowerCase().indexOf(TEMPLATE_VARIANT_SEPARATOR.toLowerCase());
  if (variantIndex !== -1) {
    variant = normalize(metadata.slice(variantIndex + TEMPLATE_VARIANT_SEPARATOR.length));
    metadata = metadata.slice(0, variantIndex);
  }

  const contextIndex = metadata.toLowerCase().indexOf(TEMPLATE_CONTEXT_SEPARATOR.toLowerCase());
  if (contextIndex !== -1) {
    context = normalize(metadata.slice(contextIndex + TEMPLATE_CONTEXT_SEPARATOR.length));
    metadata = metadata.slice(0, contextIndex);
  }

  return { key: normalize(metadata), context, variant };
}

function withStableKey(data, key, context = null, variant = null) {
  const normalizedContext = normalize(context);
  const normalizedVariant = normalize(variant);
  const authorName = [
    `${TEMPLATE_KEY_PREFIX} ${normalize(key)}`,
    normalizedContext ? `${TEMPLATE_CONTEXT_SEPARATOR} ${normalizedContext}` : '',
    normalizedVariant ? `${TEMPLATE_VARIANT_SEPARATOR} ${normalizedVariant}` : '',
  ].join('').slice(0, 256);

  return {
    ...data,
    author: {
      ...(data.author || {}),
      name: authorName,
    },
  };
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

function discoverySuffix(seed) {
  const numeric = Number.parseInt(shortHash(seed), 16) >>> 0;
  let bits = '';
  for (let bit = 31; bit >= 0; bit -= 1) {
    bits += (numeric >>> bit) & 1 ? DISCOVERY_ONE : DISCOVERY_ZERO;
  }
  return `${DISCOVERY_EDGE}${bits}${DISCOVERY_EDGE}`;
}

function stripDiscoverySuffix(value) {
  return String(value || '').replace(/\u2063[\u200B\u200C]+\u2063$/u, '');
}

function seedToEmbed(seed) {
  return new EmbedBuilder(withStableKey({
    title: seed.title,
    description: seed.description,
    color: seed.color,
  }, seed.key, seed.context));
}

function extractDynamicValues(description = '') {
  const text = String(description || '');
  const money = text.match(/\$[\d,.]+/g) || [];
  return {
    channel: text.match(/<#\d+>/)?.[0] || null,
    current: money[0] || null,
    required: money[1] || null,
    time: text.match(/\*\*([^*]+)\*\*/)?.[1] || null,
    command: text.match(/\/[a-z0-9_-]+/i)?.[0] || null,
    code: text.match(/`([^`]+)`/)?.[1] || null,
  };
}

function renderTemplateDescription(templateDescription, runtimeDescription) {
  const template = String(templateDescription || '');
  if (!template.includes('{')) return template || runtimeDescription;

  const values = extractDynamicValues(runtimeDescription);
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    if (value) output = output.replaceAll(`{${key}}`, value);
  }

  return /\{[a-z0-9_-]+\}/i.test(output) ? runtimeDescription : output;
}

function rememberTemplate(key, embed, contextOverride = null) {
  const normalizedKey = normalize(key);
  if (!normalizedKey || !embed) return;
  const metadata = parseTemplateMetadata(embed);
  const context = normalize(contextOverride || metadata.context);
  templateCache.set(cacheIdentity(normalizedKey, context), cloneData(embed));
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingTemplates();
  }, 350);
  flushTimer.unref?.();
}

function queueRuntimeTemplate(embed, contextHint = null, { keyOverride = null, variant = null } = {}) {
  const data = cloneData(embed);
  if (isInternalTemplate(data)) return false;

  const key = normalize(keyOverride || stripDiscoverySuffix(data.title));
  const context = normalize(contextHint || inferContextHint());
  const normalizedVariant = normalize(variant);
  const entryIdentity = catalogIdentity(key, context, normalizedVariant);

  if (!key || catalogEntries.has(entryIdentity) || pendingTemplates.has(entryIdentity)) return false;
  if (!normalizedVariant && templateCache.has(cacheIdentity(key, context))) return false;

  pendingTemplates.set(entryIdentity, withStableKey(data, key, context, normalizedVariant));
  scheduleFlush();
  return true;
}

export function captureSystemEmbedData(embedData, contextSource = null) {
  const data = cloneData(embedData);
  if (isInternalTemplate(data)) return false;

  const trace = getTraceContext();
  const explicitContext = inferContextHint(contextSource);
  const traceContext = inferContextHint(trace?.command || null);
  const context = explicitContext || traceContext;

  if (!context && !contextSource) return false;
  return queueRuntimeTemplate(data, context);
}

export function registerDiscoveredEmbedDefinition({
  title,
  description = null,
  color = 0x5865F2,
  context = 'botlog',
  variantId = null,
} = {}) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle || INTERNAL_TEMPLATE_TITLES.has(normalize(cleanTitle))) return false;

  const variant = shortHash(variantId || `${context}:${cleanTitle}:${description || ''}`);
  const suffix = discoverySuffix(variant);
  const visibleLength = Math.max(1, 256 - suffix.length);
  const data = {
    title: `${cleanTitle.slice(0, visibleLength)}${suffix}`,
    color: Number.isInteger(color) ? color : 0x5865F2,
  };
  if (description) data.description = String(description).slice(0, 4096);

  return queueRuntimeTemplate(data, normalize(context) || 'botlog', {
    keyOverride: cleanTitle,
    variant,
  });
}

function templateForRuntime(key, context) {
  const exact = normalize(context);
  const parent = parentContext(exact);
  return templateCache.get(cacheIdentity(key, exact))
    || (parent ? templateCache.get(cacheIdentity(key, parent)) : null)
    || templateCache.get(cacheIdentity(key, null))
    || null;
}

export function applySystemEmbedTemplate(embed) {
  if (!embed) return embed;
  const data = cloneData(embed);
  const key = normalize(stripDiscoverySuffix(data.title));
  if (!key) return embed;

  const context = inferContextHint();
  const template = templateForRuntime(key, context);

  if (!template) {
    queueRuntimeTemplate(embed, context);
    return embed;
  }

  const next = { ...data };
  if (template.title) next.title = stripDiscoverySuffix(template.title);
  if (Number.isInteger(template.color)) next.color = template.color;
  if (template.description) next.description = renderTemplateDescription(template.description, data.description);
  if (template.footer?.text) next.footer = { ...template.footer };
  else delete next.footer;
  if (template.thumbnail?.url) next.thumbnail = { ...template.thumbnail };
  else delete next.thumbnail;
  if (template.image?.url) next.image = { ...template.image };
  else delete next.image;

  return new EmbedBuilder(next);
}

async function loadEditedVariants(guildId) {
  const stored = await getFromDb(editedVariantsKey(guildId), []);
  const set = new Set(Array.isArray(stored) ? stored.map(normalize).filter(Boolean) : []);
  editedVariants.set(String(guildId), set);
  return set;
}

async function saveEditedVariants(guildId) {
  const set = editedVariants.get(String(guildId)) || new Set();
  await setInDb(editedVariantsKey(guildId), [...set]);
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

function refreshCacheFromMessages(messages, guildId) {
  const edited = editedVariants.get(String(guildId)) || new Set();
  for (const message of messages) {
    for (const embed of message.embeds || []) {
      const metadata = parseTemplateMetadata(embed);
      if (!metadata.key) continue;
      catalogEntries.add(catalogIdentity(metadata.key, metadata.context, metadata.variant));
      if (!metadata.variant || edited.has(metadata.variant)) {
        rememberTemplate(metadata.key, embed, metadata.context);
      }
    }
  }
}

async function registerCatalogMessages(messages) {
  if (!messages?.length) return;
  try {
    const { registerCloudyEmbedMessages } = await import('./embedRegistryService.js');
    await registerCloudyEmbedMessages(messages, 'system-catalog');
  } catch (error) {
    logger.warn(`Failed to register system embed catalog messages: ${error.message}`);
  }
}

async function saveCatalogIds(guildId, messages) {
  await setInDb(storageKey(guildId), messages.map(message => message.id));
}

function markInternalWrite(messageId) {
  if (messageId) internalCatalogWrites.set(String(messageId), Date.now());
}

function consumeInternalWrite(messageId) {
  const key = String(messageId || '');
  const timestamp = internalCatalogWrites.get(key);
  if (!timestamp) return false;
  internalCatalogWrites.delete(key);
  return Date.now() - timestamp <= INTERNAL_WRITE_TTL_MS;
}

async function ensureSeedTemplates(context, messages) {
  const existing = new Set();
  for (const message of messages) {
    for (const embed of message.embeds || []) {
      const metadata = parseTemplateMetadata(embed);
      existing.add(catalogIdentity(metadata.key, metadata.context, metadata.variant));
    }
  }

  const missing = DEFAULT_TEMPLATES.filter(seed => !existing.has(catalogIdentity(seed.key, seed.context, null)));
  if (!missing.length) return messages;

  const payloads = missing.map(seedToEmbed);
  let target = messages.at(-1) || null;
  let targetEmbeds = target ? [...target.embeds].map(embed => new EmbedBuilder(embed.toJSON())) : [];

  for (const embed of payloads) {
    if (!target || targetEmbeds.length >= MAX_EMBEDS_PER_MESSAGE) {
      target = await context.channel.send({ content: CATALOG_CONTENT, embeds: [] }).catch(() => null);
      if (!target) break;
      messages.push(target);
      targetEmbeds = [];
    }

    targetEmbeds.push(embed);
    markInternalWrite(target.id);
    target = await target.edit({ content: CATALOG_CONTENT, embeds: targetEmbeds }).catch(() => target);
  }

  await saveCatalogIds(context.guild.id, messages);
  return messages;
}

async function discoverStaticTemplates() {
  if (!discoveryPromise) {
    discoveryPromise = discoverEmbedDefinitions()
      .then(definitions => {
        let queued = 0;
        for (const definition of definitions) {
          if (registerDiscoveredEmbedDefinition(definition)) queued += 1;
        }
        logger.info(`Embed builder source discovery found ${definitions.length} definitions (${queued} new).`);
        return definitions.length;
      })
      .catch(error => {
        logger.warn(`Embed builder source discovery failed: ${error.message}`);
        return 0;
      });
  }
  return discoveryPromise;
}

export async function ensureSystemEmbedCatalogs(client) {
  await discoverStaticTemplates();

  for (const guild of client.guilds.cache.values()) {
    const channel = findCatalogChannel(guild);
    if (!channel?.messages?.fetch) continue;

    const context = { guild, channel };
    contexts.set(guild.id, context);
    await loadEditedVariants(guild.id);

    let messages = await loadCatalogMessages(context);
    messages = await ensureSeedTemplates(context, messages);
    refreshCacheFromMessages(messages, guild.id);
    await registerCatalogMessages(messages);
  }

  if (pendingTemplates.size) await flushPendingTemplates();
}

export async function syncSystemEmbedCatalogMessage(message) {
  if (!message?.guildId || !message?.channelId || !message?.embeds?.length) return false;
  const context = contexts.get(message.guildId);
  if (!context || String(context.channel.id) !== String(message.channelId)) return false;

  const ids = await getFromDb(storageKey(message.guildId), []);
  if (!Array.isArray(ids) || !ids.includes(message.id)) return false;

  const internalWrite = consumeInternalWrite(message.id);
  if (!internalWrite) {
    const edited = editedVariants.get(String(message.guildId)) || new Set();
    let changed = false;
    for (const embed of message.embeds || []) {
      const metadata = parseTemplateMetadata(embed);
      if (metadata.variant && !edited.has(metadata.variant)) {
        edited.add(metadata.variant);
        changed = true;
      }
    }
    if (changed) {
      editedVariants.set(String(message.guildId), edited);
      await saveEditedVariants(message.guildId);
    }
  }

  refreshCacheFromMessages([message], message.guildId);
  await registerCatalogMessages([message]);
  return true;
}

async function appendRuntimeTemplate(context, data) {
  const metadata = parseTemplateMetadata(data);
  const identity = catalogIdentity(metadata.key, metadata.context, metadata.variant);
  if (catalogEntries.has(identity)) return false;

  let messages = await loadCatalogMessages(context);
  let target = messages.at(-1) || null;
  let embeds = target ? [...target.embeds].map(embed => new EmbedBuilder(embed.toJSON())) : [];

  if (!target || embeds.length >= MAX_EMBEDS_PER_MESSAGE) {
    target = await context.channel.send({ content: CATALOG_CONTENT, embeds: [] }).catch(() => null);
    if (!target) return false;
    messages.push(target);
    embeds = [];
  }

  embeds.push(new EmbedBuilder(data));
  markInternalWrite(target.id);
  const edited = await target.edit({ content: CATALOG_CONTENT, embeds }).catch(() => null);
  if (!edited) return false;

  await saveCatalogIds(context.guild.id, messages);
  catalogEntries.add(identity);
  if (!metadata.variant) rememberTemplate(metadata.key, data, metadata.context);
  await registerCatalogMessages([edited]);
  return true;
}

async function flushPendingTemplates() {
  if (!pendingTemplates.size || !contexts.size) return;
  const queued = [...pendingTemplates.entries()];
  pendingTemplates.clear();

  for (const [identity, data] of queued) {
    if (catalogEntries.has(identity)) continue;
    for (const context of contexts.values()) {
      await appendRuntimeTemplate(context, data).catch(error => {
        logger.warn(`Failed to append runtime embed template: ${error.message}`);
      });
    }
  }
}
