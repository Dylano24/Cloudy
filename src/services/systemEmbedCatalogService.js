import { EmbedBuilder } from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const CATALOG_PREFIX = 'cloudy:system-embed-catalog:';
const CATALOG_CONTENT = 'System & error embed templates';
const MAX_EMBEDS_PER_MESSAGE = 10;
const TEMPLATE_KEY_PREFIX = 'Cloudy template key:';

const contexts = new Map();
const templateCache = new Map();
const pendingTemplates = new Map();
let flushTimer = null;

const DEFAULT_TEMPLATES = [
  { key: 'wrong channel', title: 'Wrong channel', description: 'This command can only be used in the dedicated channel. Please use {channel} to play.', color: 0xED4245 },
  { key: 'not enough money', title: 'Not enough money', description: 'You only have {current} cash, but you are trying to bet {required}.', color: 0xED4245 },
  { key: 'invalid input', title: 'Invalid Input', description: 'Please check your input and try again.', color: 0xED4245 },
  { key: 'permission denied', title: 'Permission Denied', description: "You don't have permission to do that.", color: 0xED4245 },
  { key: 'configuration error', title: 'Configuration Error', description: 'This feature is not set up yet. Ask a server administrator to configure it.', color: 0xED4245 },
  { key: 'database error', title: 'Database Error', description: 'Something went wrong while saving data. Please try again in a moment.', color: 0xED4245 },
  { key: 'network error', title: 'Network Error', description: 'I could not reach an external service. Please try again in a moment.', color: 0xED4245 },
  { key: 'discord api error', title: 'Discord API Error', description: 'Discord rejected that request. Please try again in a moment.', color: 0xED4245 },
  { key: 'input error', title: 'Input Error', description: 'There was a problem with your request. Check your input and try again.', color: 0xED4245 },
  { key: 'too fast', title: 'Too Fast', description: "You're doing that too quickly. Wait a moment and try again.", color: 0xFEE75C },
  { key: 'something went wrong', title: 'Something Went Wrong', description: 'Something went wrong. Please try again in a moment.', color: 0xED4245 },
];

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function storageKey(guildId) {
  return `${CATALOG_PREFIX}${guildId}`;
}

function cloneData(embed) {
  return embed?.toJSON ? embed.toJSON() : { ...(embed || {}) };
}

function findCatalogChannel(guild) {
  return guild?.channels?.cache?.find(channel => {
    const name = normalize(channel?.name);
    return channel?.isTextBased?.() && channel?.isSendable?.()
      && (name === 'botlog' || name === 'bot-log' || name === 'bot-logs' || name.includes('botlog'));
  }) || null;
}

function withStableKey(data, key) {
  return {
    ...data,
    author: {
      ...(data.author || {}),
      name: `${TEMPLATE_KEY_PREFIX} ${normalize(key)}`,
    },
  };
}

function seedToEmbed(seed) {
  return new EmbedBuilder(withStableKey({
    title: seed.title,
    description: seed.description,
    color: seed.color,
  }, seed.key));
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

function rememberTemplate(key, embed) {
  const normalizedKey = normalize(key);
  if (!normalizedKey || !embed) return;
  templateCache.set(normalizedKey, cloneData(embed));
}

function templateKeyFromEmbed(embed) {
  const data = cloneData(embed);
  const authorName = String(data.author?.name || '');
  if (authorName.toLowerCase().startsWith(TEMPLATE_KEY_PREFIX.toLowerCase())) {
    return normalize(authorName.slice(TEMPLATE_KEY_PREFIX.length));
  }
  return normalize(data.title);
}

function queueRuntimeTemplate(embed) {
  const data = cloneData(embed);
  const key = normalize(data.title);
  if (!key || templateCache.has(key) || pendingTemplates.has(key)) return;

  pendingTemplates.set(key, withStableKey(data, key));
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingTemplates();
  }, 500);
  flushTimer.unref?.();
}

export function applySystemEmbedTemplate(embed) {
  if (!embed) return embed;
  const data = cloneData(embed);
  const key = normalize(data.title);
  if (!key) return embed;

  const template = templateCache.get(key);
  if (!template) {
    queueRuntimeTemplate(embed);
    return embed;
  }

  const next = { ...data };
  if (template.title) next.title = template.title;
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

async function loadCatalogMessages(context) {
  const ids = await getFromDb(storageKey(context.guild.id), []);
  const messages = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const message = await context.channel.messages.fetch(id).catch(() => null);
    if (message) messages.push(message);
  }
  return messages;
}

function refreshCacheFromMessages(messages) {
  for (const message of messages) {
    for (const embed of message.embeds || []) {
      const key = templateKeyFromEmbed(embed);
      if (key) rememberTemplate(key, embed);
    }
  }
}

async function saveCatalogIds(guildId, messages) {
  await setInDb(storageKey(guildId), messages.map(message => message.id));
}

async function ensureSeedTemplates(context, messages) {
  const existing = new Set();
  for (const message of messages) {
    for (const embed of message.embeds || []) existing.add(templateKeyFromEmbed(embed));
  }

  const missing = DEFAULT_TEMPLATES.filter(seed => !existing.has(seed.key));
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
    target = await target.edit({ content: CATALOG_CONTENT, embeds: targetEmbeds }).catch(() => target);
  }

  await saveCatalogIds(context.guild.id, messages);
  return messages;
}

export async function ensureSystemEmbedCatalogs(client) {
  for (const guild of client.guilds.cache.values()) {
    const channel = findCatalogChannel(guild);
    if (!channel?.messages?.fetch) continue;

    const context = { guild, channel };
    contexts.set(guild.id, context);

    let messages = await loadCatalogMessages(context);
    messages = await ensureSeedTemplates(context, messages);
    refreshCacheFromMessages(messages);
  }

  if (pendingTemplates.size) await flushPendingTemplates();
}

export async function syncSystemEmbedCatalogMessage(message) {
  if (!message?.guildId || !message?.channelId || !message?.embeds?.length) return false;
  const context = contexts.get(message.guildId);
  if (!context || String(context.channel.id) !== String(message.channelId)) return false;

  const ids = await getFromDb(storageKey(message.guildId), []);
  if (!Array.isArray(ids) || !ids.includes(message.id)) return false;

  refreshCacheFromMessages([message]);
  return true;
}

async function appendRuntimeTemplate(context, data) {
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
  const edited = await target.edit({ content: CATALOG_CONTENT, embeds }).catch(() => null);
  if (!edited) return false;

  await saveCatalogIds(context.guild.id, messages);
  rememberTemplate(templateKeyFromEmbed(data), data);
  return true;
}

async function flushPendingTemplates() {
  if (!pendingTemplates.size || !contexts.size) return;
  const queued = [...pendingTemplates.entries()];
  pendingTemplates.clear();

  for (const [, data] of queued) {
    for (const context of contexts.values()) {
      await appendRuntimeTemplate(context, data).catch(error => {
        logger.warn(`Failed to append runtime embed template: ${error.message}`);
      });
    }
  }
}
