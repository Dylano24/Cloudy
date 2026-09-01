import { Events } from 'discord.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import {
  applyPlainResponseTemplate,
  applyRuntimeEmbedTemplateData,
  captureSystemEmbedData,
} from '../services/systemEmbedCatalogService.js';
import { decoratePayloadWithSavedTemplates } from '../services/embedTemplateService.js';
import { logger } from '../utils/logger.js';
import {
  isInternalResponsePayload,
  stripInternalResponsePayloadMarker,
} from '../services/internalResponsePayloadService.js';

const PATCH_MARKER = Symbol.for('cloudy.fullResponseCatalogCapture');
const SAVED_TEMPLATE_MARKER = Symbol.for('cloudy.savedEmbedTemplateApplied');
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

function interactionContext(interaction) {
  if (!interaction) return null;
  return {
    commandName: interaction.commandName || canonicalComponentCommand(interaction.customId) || '',
    customId: interaction.customId || '',
    channel: interaction.channel || null,
  };
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

function sourceLocation(source) {
  const channel = source?.channel;
  const guildId = channel?.guildId || channel?.guild?.id || null;
  const channelId = channel?.id || null;
  return { guildId, channelId };
}

async function applyPayloadTemplates(payload, source) {
  if (payload == null) return payload;
  if (isInternalResponsePayload(payload)) return stripInternalResponsePayloadMarker(payload);
  if (typeof payload === 'string') return applyPlainResponseTemplate(payload, source);
  if (typeof payload !== 'object') return payload;

  let next = { ...payload };
  if (Array.isArray(payload.embeds)) {
    next.embeds = payload.embeds.map(embed => {
      if (embed?.[SAVED_TEMPLATE_MARKER]) return embed;
      const data = embed?.toJSON ? embed.toJSON() : embed;
      if (!data || typeof data !== 'object') return embed;
      return applyRuntimeEmbedTemplateData(data, source);
    });

    // This is the single final Builder step for every interaction response.
    // System/runtime templates run first; the saved channel/global Builder style
    // runs last and is marked so nothing is allowed to overwrite it afterward.
    const { guildId, channelId } = sourceLocation(source);
    if (guildId && channelId) {
      next = await decoratePayloadWithSavedTemplates(guildId, channelId, next);
    }
  }

  if (typeof payload.content === 'string' && payload.content.trim()) {
    next = applyPlainResponseTemplate(next, source);
  }
  return next;
}

function capturePayload(payload, source) {
  if (payload == null) return false;
  if (isInternalResponsePayload(payload)) return false;
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
  return capturePayload({ content: message.content || '', embeds: message.embeds || [] }, messageContext(message));
}

function embedJson(embed) {
  return embed?.toJSON ? embed.toJSON() : embed || null;
}

async function applyTemplatesToExistingMessage(message) {
  if (!message?.client?.user?.id || !message.guildId || !message.editable) return false;
  if (message.author?.id !== message.client.user.id) return false;
  if (String(message.content || '').trim() === SYSTEM_CATALOG_CONTENT) return false;
  if (autoApplyingMessageIds.has(message.id)) return false;

  // Interaction replies are finalized before send by patchInteractionCapture.
  if (message.interaction || message.interactionMetadata) return false;

  const currentContent = String(message.content || '');
  const currentEmbeds = (message.embeds || []).map(embedJson);
  const templated = await applyPayloadTemplates({
    content: currentContent,
    embeds: message.embeds || [],
  }, messageContext(message));

  const nextContent = typeof templated?.content === 'string' ? templated.content : currentContent;
  const nextEmbeds = Array.isArray(templated?.embeds) ? templated.embeds.map(embedJson) : currentEmbeds;
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
    color: 0x5865F2,
    fields: [
      { name: 'Your Hand', value: '{dynamic}\nValue: **{dynamic}**', inline: true },
      { name: 'Dealer Hand', value: '{dynamic}\nValue: **?**', inline: true },
    ],
  }, blackjack);

  for (const title of ['Win', 'Loss', 'Push', 'Bust', 'Blackjack', 'Expired']) {
    captureSystemEmbedData({
      title: `Result: ${title}`,
      description: 'Payout: **{dynamic}**\nCash balance: **{dynamic}**',
      color: title === 'Win' || title === 'Blackjack'
        ? 0x57F287
        : title === 'Loss' || title === 'Bust'
          ? 0xED4245
          : 0x5865F2,
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

export function patchInteractionCapture() {
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
        if (isInternalResponsePayload(payload)) {
          return original(stripInternalResponsePayloadMarker(payload), ...args);
        }
        let outgoing = payload;
        try {
          capturePayload(payload, source);
          outgoing = await applyPayloadTemplates(payload, source);
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
      const message = newMessage?.partial ? await newMessage.fetch().catch(() => null) : newMessage;
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

    logger.warn('[EMBED_BUILDER] Unified response templates enabled: runtime values first, saved Builder style last.');
  },
};
