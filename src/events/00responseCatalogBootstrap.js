import {
  ChannelType,
  EmbedBuilder,
  Events,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { discoverEmbedDefinitions } from '../services/embedDefinitionDiscoveryService.js';
import { ensureSystemEmbedCatalogs } from '../services/systemEmbedCatalogService.js';
import { registerCloudyEmbedMessages } from '../services/embedRegistryService.js';

const CATALOG_CONTENT = 'System & error embed templates';
const CATALOG_PREFIX = 'cloudy:system-embed-catalog:';
const TEMPLATE_KEY_PREFIX = 'Cloudy template key:';
const CONTEXT_SEPARATOR = ' || Cloudy context:';
const KIND_SEPARATOR = ' || Cloudy kind:';
const TEMP_THREAD_NAME = 'cloudy-response-catalog-loading';
const FINAL_THREAD_NAME = 'botlog';
const BOT_COMMANDS_CHANNEL_ID = '1539371836570083368';

const DEFAULTS = [
  ['wrong channel', 'gambling', 'Wrong channel', 'This command can only be used in the dedicated channel. Please use {dynamic} to play.', 0xED4245],
  ['not enough money', 'gambling', 'Not enough money', 'You only have {dynamic} cash, but you are trying to bet {dynamic}.', 0xED4245],
  ['invalid input', 'gambling', 'Invalid Input', 'Please check your input and try again.', 0xED4245],
  ['invalid code', 'botlog', 'Invalid code', 'That code is invalid or no longer available.', 0xED4245],
  ['permission denied', 'botlog', 'Permission Denied', "You don't have permission to do that.", 0xED4245],
  ['configuration error', 'botlog', 'Configuration Error', 'This feature is not set up yet. Ask a server administrator to configure it.', 0xED4245],
  ['database error', 'botlog', 'Database Error', 'Something went wrong while saving data. Please try again in a moment.', 0xED4245],
  ['network error', 'botlog', 'Network Error', 'I could not reach an external service. Please try again in a moment.', 0xED4245],
  ['discord api error', 'botlog', 'Discord API Error', 'Discord rejected that request. Please try again in a moment.', 0xED4245],
  ['input error', 'botlog', 'Input Error', 'There was a problem with your request. Check your input and try again.', 0xED4245],
  ['too fast', 'botlog', 'Too Fast', "You're doing that too quickly. Wait a moment and try again.", 0xFEE75C],
  ['something went wrong', 'botlog', 'Something Went Wrong', 'Something went wrong. Please try again in a moment.', 0xED4245],
];

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function compact(value) {
  return normalize(value).replace(/[^a-z0-9]/g, '');
}

function shortHash(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function canonical(value = '') {
  return normalize(String(value || '')
    .replace(/\{dynamic\}/gi, '{dynamic}')
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>|<a?:[^:>]+:\d+>|https?:\/\/\S+|\$[\d,.]+|\b\d{1,3}(?:\.\d+)?%\b|\b\d{17,20}\b|\b\d+(?:\.\d+)?\b/g, '{dynamic}'));
}

function responseKey(kind, title = '', description = '') {
  return `${kind}:${shortHash(`${canonical(title)}\n${canonical(description)}`)}`;
}

function metadata(key, context, kind) {
  return `${TEMPLATE_KEY_PREFIX} ${normalize(key)}${CONTEXT_SEPARATOR} ${normalize(context)}${KIND_SEPARATOR} ${kind}`.slice(0, 256);
}

function definitionEntry(definition) {
  const kind = normalize(definition.kind) === 'content' ? 'content' : 'embed';
  const context = normalize(definition.context) || 'botlog';
  const description = String(definition.description || definition.content || '').slice(0, 4096);
  const title = kind === 'content'
    ? String(definition.label || 'Bot message').slice(0, 256)
    : String(definition.title || 'Untitled embed').slice(0, 256);
  const key = responseKey(kind, kind === 'embed' ? String(definition.title || '') : '', description);
  return {
    identity: `${context}::${key}`,
    embed: new EmbedBuilder({
      title,
      ...(description ? { description } : {}),
      color: Number.isInteger(definition.color) ? definition.color : 0x5865F2,
      author: { name: metadata(key, context, kind) },
    }),
  };
}

function defaultEntries() {
  return DEFAULTS.map(([key, context, title, description, color]) => ({
    identity: `${context}::${key}`,
    embed: new EmbedBuilder({
      title,
      description,
      color,
      author: { name: metadata(key, context, 'embed') },
    }),
  }));
}

function messageIdentities(message) {
  const identities = [];
  for (const embed of message?.embeds || []) {
    const author = String(embed.author?.name || '');
    if (!author.toLowerCase().startsWith(TEMPLATE_KEY_PREFIX.toLowerCase())) continue;
    let raw = author.slice(TEMPLATE_KEY_PREFIX.length).trim();
    const kindIndex = raw.toLowerCase().indexOf(KIND_SEPARATOR.toLowerCase());
    if (kindIndex !== -1) raw = raw.slice(0, kindIndex);
    let context = '';
    const contextIndex = raw.toLowerCase().indexOf(CONTEXT_SEPARATOR.toLowerCase());
    if (contextIndex !== -1) {
      context = normalize(raw.slice(contextIndex + CONTEXT_SEPARATOR.length));
      raw = raw.slice(0, contextIndex);
    }
    identities.push(`${context || 'global'}::${normalize(raw)}`);
  }
  return identities;
}

async function getCatalogThread(guild) {
  const cached = [...guild.channels.cache.values()].find(channel =>
    channel?.isThread?.() && [FINAL_THREAD_NAME, TEMP_THREAD_NAME].includes(normalize(channel.name)),
  );
  if (cached) {
    if (cached.archived) await cached.setArchived(false).catch(() => {});
    return cached;
  }

  const parent = guild.channels.cache.get(BOT_COMMANDS_CHANNEL_ID)
    || [...guild.channels.cache.values()].find(channel =>
      channel?.type === ChannelType.GuildText && compact(channel.name).includes('botcommands'),
    );
  if (!parent?.threads?.create) return null;

  return parent.threads.create({
    name: TEMP_THREAD_NAME,
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: 'Cloudy internal response template catalog',
  }).catch(error => {
    logger.warn(`[EMBED_BUILDER] Could not create private response catalog thread: ${error.message}`);
    return null;
  });
}

async function bootstrapGuild(guild, definitions) {
  const thread = await getCatalogThread(guild);
  if (!thread?.messages?.fetch) {
    logger.warn(`[EMBED_BUILDER] No private catalog thread available in ${guild.id}.`);
    return { added: 0, total: 0 };
  }

  if (normalize(thread.name) !== TEMP_THREAD_NAME) {
    await thread.setName(TEMP_THREAD_NAME).catch(() => {});
  }

  const key = `${CATALOG_PREFIX}${guild.id}`;
  const storedIds = await getFromDb(key, []);
  const messages = [];
  const existing = new Set();

  for (const id of Array.isArray(storedIds) ? storedIds : []) {
    const message = await thread.messages.fetch(id).catch(() => null);
    if (!message) continue;
    messages.push(message);
    for (const identity of messageIdentities(message)) existing.add(identity);
  }

  const allEntries = [...defaultEntries(), ...definitions.map(definitionEntry)];
  const missing = allEntries.filter(entry => !existing.has(entry.identity));
  let added = 0;

  for (let index = 0; index < missing.length; index += 10) {
    const batch = missing.slice(index, index + 10);
    const message = await thread.send({
      content: CATALOG_CONTENT,
      embeds: batch.map(entry => entry.embed),
    }).catch(error => {
      logger.warn(`[EMBED_BUILDER] Catalog batch failed: ${error.message}`);
      return null;
    });
    if (!message) continue;
    messages.push(message);
    added += batch.length;
    await registerCloudyEmbedMessages([message], 'system-catalog').catch(() => {});
  }

  await setInDb(key, messages.map(message => message.id));
  await registerCloudyEmbedMessages(messages, 'system-catalog').catch(() => {});
  await thread.setName(FINAL_THREAD_NAME).catch(() => {});

  return { added, total: allEntries.length };
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const definitions = await discoverEmbedDefinitions().catch(error => {
      logger.warn(`[EMBED_BUILDER] Source discovery failed: ${error.message}`);
      return [];
    });

    let added = 0;
    for (const guild of client.guilds.cache.values()) {
      const result = await bootstrapGuild(guild, definitions);
      added += result.added;
    }

    await ensureSystemEmbedCatalogs(client).catch(error => {
      logger.warn(`[EMBED_BUILDER] Final catalog sync failed: ${error.message}`);
    });
    logger.warn(`[EMBED_BUILDER] Bootstrap complete: ${definitions.length} definitions, ${added} added.`);
  },
};
