import { Events } from 'discord.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import {
  applyPlainResponseTemplate,
  applyRuntimeEmbedTemplateData,
  captureSystemEmbedData,
} from '../services/systemEmbedCatalogService.js';
import { logger } from '../utils/logger.js';

const PATCH_MARKER = Symbol.for('cloudy.fullResponseCatalogCapture');
const HISTORY_LIMIT = 100;
const STARTUP_SCAN_DELAY_MS = 7000;
const SYSTEM_CATALOG_CONTENT = 'System & error embed templates';
const autoApplyingMessageIds = new Set();

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
  ];

  return mappings.find(([pattern]) => pattern.test(value))?.[1] || '';
}

function interactionContext(interaction) {
  if (!interaction) return null;
  const commandName = interaction.commandName
    || canonicalComponentCommand(interaction.customId)
    || '';
  return {
    commandName,
    customId: interaction.customId || '',
    channel: interaction.channel || null,
  };
}

function messageContext(message) {
  const metadata = message?.interactionMetadata || message?.interaction || null;
  const commandName = metadata?.commandName
    || metadata?.name
    || canonicalComponentCommand(metadata?.customId)
    || '';
  return {
    commandName,
    customId: metadata?.customId || '',
    channel: message?.channel || null,
  };
}

function applyPayloadTemplates(payload, source) {
  if (payload == null) return payload;

  if (typeof payload === 'string') {
    return applyPlainResponseTemplate(payload, source);
  }

  if (typeof payload !== 'object') return payload;

  let next = { ...payload };
  if (Array.isArray(payload.embeds)) {
    next.embeds = payload.embeds.map(embed => {
      const data = embed?.toJSON ? embed.toJSON() : embed;
      if (!data || typeof data !== 'object') return embed;
      return applyRuntimeEmbedTemplateData(data, source);
    });
  }

  if (typeof payload.content === 'string' && payload.content.trim()) {
    next = applyPlainResponseTemplate(next, source);
  }

  return next;
}

function capturePayload(payload, source) {
  if (payload == null) return false;

  let captured = false;
  const normalized = typeof payload === 'string' ? { content: payload } : payload;

  if (Array.isArray(normalized?.embeds)) {
    for (const embed of normalized.embeds) {
      const data = embed?.toJSON ? embed.toJSON() : embed;
      if (!data || typeof data !== 'object') continue;
      if (captureSystemEmbedData(data, source)) captured = true;
    }
  }

  if (typeof normalized?.content === 'string' && normalized.content.trim()) {
    if (normalized.content.trim() !== SYSTEM_CATALOG_CONTENT) {
      applyPlainResponseTemplate({ content: normalized.content }, source);
      captured = true;
    }
  }

  return captured;
}

function captureMessage(message) {
  if (!message?.client?.user?.id || !message.guildId) return false;
  if (message.author?.id !== message.client.user.id) return false;
  if (String(message.content || '').trim() === SYSTEM_CATALOG_CONTENT) return false;

  const source = messageContext(message);
  return capturePayload({
    content: message.content || '',
    embeds: message.embeds || [],
  }, source);
}

function embedJson(embed) {
  return embed?.toJSON ? embed.toJSON() : embed || null;
}

async function applyTemplatesToExistingMessage(message) {
  if (!message?.client?.user?.id || !message.guildId || !message.editable) return false;
  if (message.author?.id !== message.client.user.id) return false;
  if (String(message.content || '').trim() === SYSTEM_CATALOG_CONTENT) return false;
  if (autoApplyingMessageIds.has(message.id)) return false;

  const source = messageContext(message);
  const runtimePayload = {
    content: message.content || '',
    embeds: message.embeds || [],
  };
  const templated = applyPayloadTemplates(runtimePayload, source);

  const currentContent = String(message.content || '');
  const nextContent = typeof templated?.content === 'string' ? templated.content : currentContent;
  const currentEmbeds = (message.embeds || []).map(embedJson);
  const nextEmbeds = Array.isArray(templated?.embeds)
    ? templated.embeds.map(embedJson)
    : currentEmbeds;

  const contentChanged = currentContent !== nextContent;
  const embedsChanged = JSON.stringify(currentEmbeds) !== JSON.stringify(nextEmbeds);
  if (!contentChanged && !embedsChanged) return false;

  const editPayload = {};
  if (contentChanged) editPayload.content = nextContent;
  if (embedsChanged) editPayload.embeds = templated.embeds;

  autoApplyingMessageIds.add(message.id);
  try {
    await message.edit(editPayload);
    return true;
  } catch (error) {
    logger.debug(`[EMBED_BUILDER] Automatic response template edit skipped: ${error?.message || error}`);
    return false;
  } finally {
    const timer = setTimeout(() => autoApplyingMessageIds.delete(message.id), 1500);
    timer.unref?.();
  }
}

function seedKnownGameResponses() {
  const roulette = { commandName: 'roulette' };
  const blackjack = { commandName: 'blackjack' };
  const baccarat = { commandName: 'baccarat' };

  captureSystemEmbedData({
    title: 'Roulette — You won!',
    description: 'The wheel landed on {dynamic}\n**{dynamic} • {dynamic}**',
    color: 0x57F287,
    fields: [
      { name: 'Your bet', value: '**{dynamic}** on **{dynamic}**', inline: true },
      { name: 'Payout', value: '**{dynamic}**', inline: true },
      { name: 'Cash balance', value: '**{dynamic}**', inline: true },
    ],
  }, roulette);

  captureSystemEmbedData({
    title: 'Roulette — You lost',
    description: 'The wheel landed on {dynamic}\n**{dynamic} • {dynamic}**',
    color: 0xFEE75C,
    fields: [
      { name: 'Your bet', value: '**{dynamic}** on **{dynamic}**', inline: true },
      { name: 'Result', value: 'Lost **{dynamic}**', inline: true },
      { name: 'Cash balance', value: '**{dynamic}**', inline: true },
    ],
  }, roulette);

  captureSystemEmbedData({
    title: 'Blackjack — Bet $100',
    description: 'Cards remaining: **48**',
    color: 0x5865F2,
    fields: [
      { name: 'Your Hand', value: '{dynamic}\nValue: **{dynamic}**', inline: true },
      { name: 'Dealer Hand', value: '{dynamic}\nValue: **?**', inline: true },
    ],
  }, blackjack);

  for (const title of ['Win', 'Loss', 'Push', 'Bust', 'Blackjack', 'Expired']) {
    captureSystemEmbedData({
      title: `Result: ${title}`,
      description: 'Payout: **{dynamic}**\nCash balance: **{dynamic}**\n\nCards remaining: **{dynamic}**',
      color: title === 'Win' || title === 'Blackjack' ? 0x57F287 : title === 'Loss' || title === 'Bust' ? 0xED4245 : 0x5865F2,
      fields: [
        { name: 'Your Hand', value: '{dynamic}\nValue: **{dynamic}**', inline: true },
        { name: 'Dealer Hand', value: '{dynamic}\nValue: **{dynamic}**', inline: true },
      ],
    }, blackjack);
  }

  captureSystemEmbedData({
    title: 'Baccarat — Bet $100',
    description: 'Choose where to place your bet.',
    color: 0x5865F2,
  }, baccarat);

  captureSystemEmbedData({
    title: 'Baccarat — Result',
    description: 'You chose **{dynamic}**. Winner: **{dynamic}**\nPayout: **{dynamic}**\nCash balance: **{dynamic}**',
    color: 0x57F287,
    fields: [
      { name: 'Player Hand', value: '{dynamic}\nValue: **{dynamic}**', inline: true },
      { name: 'Banker Hand', value: '{dynamic}\nValue: **{dynamic}**', inline: true },
    ],
  }, baccarat);
}

function patchInteractionCapture() {
  if (InteractionHelper[PATCH_MARKER]) return;

  const originalPatch = InteractionHelper.patchInteractionResponses.bind(InteractionHelper);
  InteractionHelper.patchInteractionResponses = function patchAllResponseCatalogOutputs(interaction) {
    originalPatch(interaction);
    if (!interaction || interaction.__cloudyFullResponseCatalogPatched) return;

    const source = interactionContext(interaction);
    for (const method of ['reply', 'editReply', 'followUp', 'update']) {
      const original = interaction[method]?.bind(interaction);
      if (!original) continue;

      interaction[method] = async (payload, ...args) => {
        let outgoing = payload;
        try {
          capturePayload(payload, source);
          outgoing = applyPayloadTemplates(payload, source);
        } catch (error) {
          logger.debug(`[EMBED_BUILDER] Response template processing skipped for ${method}: ${error?.message || error}`);
        }
        return original(outgoing, ...args);
      };
    }

    interaction.__cloudyFullResponseCatalogPatched = true;
  };

  Object.defineProperty(InteractionHelper, PATCH_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

async function scanRecentBotResponses(client) {
  let channelsScanned = 0;
  let messagesScanned = 0;
  let responsesCaptured = 0;

  for (const guild of client.guilds.cache.values()) {
    const channels = [...guild.channels.cache.values()]
      .filter(channel => channel?.isTextBased?.() && channel?.messages?.fetch);

    for (const channel of channels) {
      const messages = await channel.messages.fetch({ limit: HISTORY_LIMIT }).catch(() => null);
      if (!messages) continue;
      channelsScanned += 1;

      for (const message of messages.values()) {
        if (message.author?.id !== client.user.id) continue;
        if (String(message.content || '').trim() === SYSTEM_CATALOG_CONTENT) continue;
        messagesScanned += 1;
        try {
          if (captureMessage(message)) responsesCaptured += 1;
        } catch (error) {
          logger.debug(`[EMBED_BUILDER] Historical response capture skipped: ${error?.message || error}`);
        }
      }
    }
  }

  logger.warn(
    `[EMBED_BUILDER] Full response history sync complete: ${channelsScanned} channels, ${messagesScanned} bot messages checked, ${responsesCaptured} response payloads captured.`,
  );
}

export default {
  name: Events.ClientReady,
  once: true,

  execute(client) {
    patchInteractionCapture();
    seedKnownGameResponses();

    client.on(Events.MessageCreate, message => {
      if (String(message?.content || '').trim() === SYSTEM_CATALOG_CONTENT) return;
      try {
        captureMessage(message);
        void applyTemplatesToExistingMessage(message);
      } catch (error) {
        logger.debug(`[EMBED_BUILDER] Live message processing skipped: ${error?.message || error}`);
      }
    });

    client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
      const message = newMessage?.partial
        ? await newMessage.fetch().catch(() => null)
        : newMessage;
      if (!message) return;
      if (String(message.content || '').trim() === SYSTEM_CATALOG_CONTENT) return;
      if (autoApplyingMessageIds.has(message.id)) return;

      try {
        captureMessage(message);
        await applyTemplatesToExistingMessage(message);
      } catch (error) {
        logger.debug(`[EMBED_BUILDER] Live message update processing skipped: ${error?.message || error}`);
      }
    });

    const timer = setTimeout(() => {
      void scanRecentBotResponses(client).catch(error => {
        logger.warn(`[EMBED_BUILDER] Full response history sync failed: ${error.message}`);
      });
    }, STARTUP_SCAN_DELAY_MS);
    timer.unref?.();

    logger.warn('[EMBED_BUILDER] Automatic response templates enabled: saved titles, text, fields, colors, footer and media are reused while live values stay dynamic.');
  },
};
