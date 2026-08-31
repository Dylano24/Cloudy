import { Events } from 'discord.js';
import {
  applyPlainResponseTemplate,
  applyRuntimeEmbedTemplateData,
  syncSystemEmbedCatalogMessage,
} from '../services/systemEmbedCatalogService.js';
import { registerCloudyEmbedMessage } from '../services/embedRegistryService.js';
import { logger } from '../utils/logger.js';

const SYSTEM_CATALOG_CONTENT = 'System & error embed templates';
const BATCH_SIZE = 100;
const guildSyncJobs = new Map();

function canonicalComponentCommand(customId = '') {
  const value = String(customId || '').toLowerCase();
  const mappings = [
    [/blackjack/, 'blackjack'],
    [/baccarat/, 'baccarat'],
    [/roulette/, 'roulette'],
    [/coin.?flip/, 'coinflip'],
    [/slots?/, 'slots'],
    [/ticket|transcript|claim|reopen/, 'ticket'],
    [/giveaway|gcreate|gend|gdelete|greroll/, 'giveaway'],
    [/music|play|skip|pause|resume|queue|volume/, 'music'],
    [/untimeout|un-timeout/, 'untimeout'],
    [/timeout|time-out/, 'timeout'],
    [/unban/, 'unban'],
    [/\bban\b/, 'ban'],
    [/\bkick\b/, 'kick'],
    [/report/, 'report'],
    [/appeal/, 'appeal'],
    [/invite/, 'invite'],
    [/welcome/, 'welcome'],
  ];
  return mappings.find(([pattern]) => pattern.test(value))?.[1] || '';
}

function canonicalEmbedCommand(message) {
  const text = (message?.embeds || [])
    .map(embed => {
      const data = embed?.toJSON ? embed.toJSON() : embed;
      return [data?.title, data?.description, ...(data?.fields || []).map(field => field?.name)]
        .filter(Boolean)
        .join(' ');
    })
    .join(' ')
    .toLowerCase();

  if (!text) return '';
  const mappings = [
    [/roulette/, 'roulette'],
    [/blackjack|dealer hand|your hand/, 'blackjack'],
    [/baccarat|banker hand|player hand/, 'baccarat'],
    [/un[-\s]?time[-\s]?out/, 'untimeout'],
    [/time[-\s]?out/, 'timeout'],
    [/unban/, 'unban'],
    [/\bban\s+log\b|account removed|automod account banned/, 'ban'],
    [/\bkick\s+log\b/, 'kick'],
    [/report(?:s)?\s+log|message reported/, 'report'],
    [/invite created|joined using invite/, 'invite'],
    [/ticket|transcript|claim/, 'ticket'],
    [/welcome to cloudy/, 'welcome'],
  ];
  return mappings.find(([pattern]) => pattern.test(text))?.[1] || '';
}

function messageContext(message) {
  const metadata = message?.interactionMetadata || message?.interaction || null;
  return {
    commandName: metadata?.commandName
      || metadata?.name
      || canonicalComponentCommand(metadata?.customId)
      || canonicalEmbedCommand(message)
      || '',
    customId: metadata?.customId || '',
    channel: message?.channel || null,
  };
}

function embedJson(embed) {
  return embed?.toJSON ? embed.toJSON() : embed || null;
}

function applyTemplates(message) {
  const source = messageContext(message);
  const currentContent = String(message.content || '');
  const currentEmbeds = (message.embeds || []).map(embedJson);

  const templatedEmbeds = (message.embeds || []).map(embed => {
    const data = embedJson(embed);
    return data && typeof data === 'object'
      ? applyRuntimeEmbedTemplateData(data, source)
      : embed;
  });

  const contentPayload = currentContent
    ? applyPlainResponseTemplate({ content: currentContent }, source)
    : { content: currentContent };
  const nextContent = typeof contentPayload?.content === 'string'
    ? contentPayload.content
    : currentContent;
  const nextEmbeds = templatedEmbeds.map(embedJson);

  return {
    changed: currentContent !== nextContent
      || JSON.stringify(currentEmbeds) !== JSON.stringify(nextEmbeds),
    content: nextContent,
    embeds: templatedEmbeds,
  };
}

async function syncMessage(message, botUserId) {
  if (!message || message.author?.id !== botUserId || !message.editable) return false;
  if (String(message.content || '').trim() === SYSTEM_CATALOG_CONTENT) return false;
  if (!message.embeds?.length && !String(message.content || '').trim()) return false;

  const next = applyTemplates(message);
  if (!next.changed) return false;

  const edited = await message.edit({
    content: next.content,
    embeds: next.embeds,
  }).catch(error => {
    logger.debug(`[EMBED_BUILDER] Previous-message template update skipped: ${error?.message || error}`);
    return null;
  });

  if (!edited) return false;
  void registerCloudyEmbedMessage(edited, 'template-history-sync')
    .catch(error => logger.debug(`[EMBED_BUILDER] Updated history registry refresh skipped: ${error?.message || error}`));
  return true;
}

async function syncChannel(channel, botUserId) {
  let before;
  let scanned = 0;
  let updated = 0;

  while (true) {
    const batch = await channel.messages.fetch({ limit: BATCH_SIZE, before }).catch(() => null);
    if (!batch?.size) break;

    for (const message of batch.values()) {
      scanned += 1;
      if (await syncMessage(message, botUserId)) updated += 1;
    }

    const oldest = batch.last();
    if (!oldest || batch.size < BATCH_SIZE) break;
    before = oldest.id;
  }

  return { scanned, updated };
}

async function syncGuildHistory(guild) {
  const existing = guildSyncJobs.get(guild.id);
  if (existing) return existing;

  const job = (async () => {
    const botUserId = guild.client.user?.id;
    if (!botUserId) return { channels: 0, scanned: 0, updated: 0 };

    let channels = 0;
    let scanned = 0;
    let updated = 0;

    const textChannels = [...guild.channels.cache.values()]
      .filter(channel => channel?.isTextBased?.() && channel?.messages?.fetch);

    for (const channel of textChannels) {
      const result = await syncChannel(channel, botUserId);
      channels += 1;
      scanned += result.scanned;
      updated += result.updated;
    }

    logger.warn(`[EMBED_BUILDER] Previous automatic messages synced: ${channels} channels, ${scanned} messages checked, ${updated} messages updated.`);
    return { channels, scanned, updated };
  })();

  guildSyncJobs.set(guild.id, job);
  try {
    return await job;
  } finally {
    if (guildSyncJobs.get(guild.id) === job) guildSyncJobs.delete(guild.id);
  }
}

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(oldMessage, newMessage) {
    const message = newMessage?.partial
      ? await newMessage.fetch().catch(() => null)
      : newMessage;
    if (!message?.guild || String(message.content || '').trim() !== SYSTEM_CATALOG_CONTENT) return;

    const synced = await syncSystemEmbedCatalogMessage(message).catch(error => {
      logger.warn(`[EMBED_BUILDER] Could not sync edited automatic template: ${error.message}`);
      return false;
    });
    if (!synced) return;

    void syncGuildHistory(message.guild).catch(error => {
      logger.warn(`[EMBED_BUILDER] Previous automatic-message sync failed: ${error.message}`);
    });
  },
};