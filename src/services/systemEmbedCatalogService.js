import { EmbedBuilder } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { getTraceContext, logger } from '../utils/logger.js';
import { discoverEmbedDefinitions } from './embedDefinitionDiscoveryService.js';

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

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function compactName(value) {
  return normalize(value).replace(/[^a-z0-9]/g, '');
}

function cloneData(value) {
  return value?.toJSON ? value.toJSON() : { ...(value || {}) };
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
  let text = String(value || '');
  text = text.replace(/\{dynamic\}/gi, () => '{dynamic}');
  text = text.replace(/<@!?\d+>|<@&\d+>|<#\d+>|<a?:[^:>]+:\d+>|https?:\/\/\S+|\$[\d,.]+|\b\d{1,3}(?:\.\d+)?%\b|\b\d{17,20}\b|\b\d+(?:\.\d+)?\b/g, match => {
    values.push(match);
    return '{dynamic}';
  });
  return {
    pattern: normalize(text),
    values,
  };
}

function renderDynamic(template, runtime) {
  const source = String(runtime || '');
  const values = dynamicParts(source).values;
  let index = 0;
  const rendered = String(template || '').replace(/\{dynamic\}/gi, () => values[index++] ?? '{dynamic}');
  return /\{dynamic\}/i.test(rendered) ? source : rendered;
}

function responseSignature(kind, title = '', description = '') {
  const titlePattern = dynamicParts(title).pattern;
  const descriptionPattern = dynamicParts(description).pattern;
  return `${kind}:${shortHash(`${titlePattern}\n${descriptionPattern}`)}`;
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
  if (!key || !data) return;
  templateCache.set(cacheIdentity(key, context), cloneData(data));
}

function findTemplate(key, context) {
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
    if (!metadata.key) continue;
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
  const key = definition.key
    || responseSignature(kind, kind === 'embed' ? sourceTitle : '', description);
  const title = kind === 'content'
    ? String(definition.label || friendlyPlainTitle(context, description)).slice(0, 256)
    : (sourceTitle || 'Untitled embed').slice(0, 256);

  return {
    key,
    context,
    kind,
    data: withStableKey({
      title,
      ...(description ? { description } : {}),
      color: Number.isInteger(definition.color) ? definition.color : 0x5865F2,
    }, key, context, kind),
  };
}

async function appendCatalogEntry(context, entry, messages) {
  const identity = cacheIdentity(entry.key, entry.context);
  if (catalogEntries.has(identity)) return false;

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
  const identity = cacheIdentity(entry.key, entry.context);
  if (catalogEntries.has(identity) || pendingTemplates.has(identity)) return false;
  pendingTemplates.set(identity, entry);
  scheduleFlush();
  return true;
}

export function registerDiscoveredEmbedDefinition(definition = {}) {
  const entry = definitionToCatalog(definition);
  if (!entry.key || isInternalTemplate(entry.data)) return false;
  return queueRuntimeEntry(entry);
}

export function captureSystemEmbedData(embedData, contextSource = null) {
  const data = cloneData(embedData);
  if (isInternalTemplate(data)) return false;
  const context = inferContextHint(contextSource);
  if (!context) return false;
  const key = responseSignature('embed', data.title, data.description);
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
  const specificKey = responseSignature('embed', data.title, data.description);
  const titleKey = normalize(data.title);
  const template = findTemplate(specificKey, context) || findTemplate(titleKey, context);

  if (!template) {
    if (context) captureSystemEmbedData(data, contextSource);
    return data;
  }

  const next = { ...data };
  if (template.title) next.title = template.title;
  if (template.description) next.description = renderDynamic(template.description, data.description);
  if (Number.isInteger(template.color)) next.color = template.color;
  if (Array.isArray(template.fields)) next.fields = template.fields.map(field => ({ ...field }));
  if (template.footer?.text) next.footer = { ...template.footer };
  else delete next.footer;
  if (template.thumbnail?.url) next.thumbnail = { ...template.thumbnail };
  else delete next.thumbnail;
  if (template.image?.url) next.image = { ...template.image };
  else delete next.image;
  return next;
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
  if (!context) return payload;
  const key = responseSignature('content', '', content);
  const template = findTemplate(key, context);

  if (!template) {
    const entry = definitionToCatalog({ kind: 'content', context, content, key });
    queueRuntimeEntry(entry);
    return payload;
  }

  const replacement = renderDynamic(template.description || content, content);
  if (typeof payload === 'string') return replacement;
  return { ...payload, content: replacement };
}

export async function ensureSystemEmbedCatalogs(client) {
  const definitions = await discoverStaticTemplates();
  let totalAdded = 0;

  for (const guild of client.guilds.cache.values()) {
    const channel = findCatalogChannel(guild);
    if (!channel?.messages?.fetch) {
      logger.warn(`[EMBED_BUILDER] No botlog channel found in guild ${guild.id}; response catalog cannot be indexed.`);
      continue;
    }

    const context = { guild, channel };
    contexts.set(guild.id, context);
    const messages = await loadCatalogMessages(context);
    for (const message of messages) rememberCatalogMessage(message);

    const entries = [
      ...DEFAULT_TEMPLATES.map(definitionToCatalog),
      ...definitions.map(definitionToCatalog),
    ];

    for (const entry of entries) {
      if (await appendCatalogEntry(context, entry, messages)) totalAdded += 1;
    }

    await saveCatalogIds(guild.id, messages);
    await registerCatalogMessages(messages).catch(error => logger.warn(`Failed to register response catalog messages: ${error.message}`));
  }

  await flushPendingTemplates();
  logger.warn(`[EMBED_BUILDER] Response catalog ready: ${definitions.length} source definitions, ${totalAdded} newly indexed.`);
  return { definitions: definitions.length, added: totalAdded };
}

export async function syncSystemEmbedCatalogMessage(message) {
  if (!message?.guildId || !message?.channelId || !message?.embeds?.length) return false;
  const context = contexts.get(message.guildId);
  if (!context || String(context.channel.id) !== String(message.channelId)) return false;

  const ids = await getFromDb(storageKey(message.guildId), []);
  if (!Array.isArray(ids) || !ids.includes(message.id)) return false;

  rememberCatalogMessage(message);
  await registerCatalogMessages([message]).catch(error => logger.warn(`Failed to sync edited response template: ${error.message}`));
  return true;
}

async function flushPendingTemplates() {
  if (!pendingTemplates.size || !contexts.size) return;
  const queued = [...pendingTemplates.values()];
  pendingTemplates.clear();

  for (const context of contexts.values()) {
    const messages = await loadCatalogMessages(context);
    for (const entry of queued) {
      await appendCatalogEntry(context, entry, messages).catch(error => {
        logger.warn(`Failed to append runtime response template: ${error.message}`);
      });
    }
  }
}
