import { isPrivateReportCasePayload } from '../utils/reportCasePrivacy.js';
// BUILDER_SAVED_PARITY_V1
import { rememberTransientPayloadIntent } from '../utils/transientResponse.js';
import { balanceResponseIdentity } from '../services/balanceResponseIdentity.js';
import { PRESERVE_EXISTING_EMBEDS } from '../services/existingEmbedPolicy.js';
import { Events, Message } from 'discord.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import {
  applyPlainResponseTemplate,
  applyRuntimeEmbedTemplateData,
  captureSystemEmbedData,
} from '../services/systemEmbedCatalogService.js';
import {
  applySavedEmbedTemplates,
  decorateEmbedWithSavedTemplate,
  warmSavedEmbedTemplateScopes,
  getCachedSavedEmbedTemplateData,
} from '../services/embedTemplateService.js';
import { isEmbedManagerSaveInProgress } from '../services/embedManagerService.js';
import { logger } from '../utils/logger.js';
import { rememberBuilderRuntimePreview } from '../services/builderRuntimePreviewService.js';
import { isBlackjackEmbed } from '../utils/blackjackEmbedPresentation.js';
import { CLOUDY_LOGO_URL } from '../services/cloudyLogoService.js';
import { getGuildConfig } from '../services/config/guildConfig.js';

const PATCH_MARKER = Symbol.for('cloudy.fullResponseCatalogCapture');
const MESSAGE_EDIT_PATCH_MARKER = Symbol.for('cloudy.fullResponseCatalogMessageEdit');
const HISTORY_LIMIT = 100;
// Historical reconciliation is background maintenance. Keep it away from the
// first minute after startup so dashboards and Builder interactions get all
// available Discord/API bandwidth first.
const STARTUP_SCAN_DELAY_MS = 90_000;
const SYSTEM_CATALOG_CONTENT = 'System & error embed templates';
const autoApplyingMessageIds = new Set();
const FIXED_NON_TICKET_LOG_CHANNEL_IDS = new Set([
  '1539375620885323826',
  '1539371111240831078',
  '1539259457404412036',
  '1539371572442435646',
  '1539372511089926244',
]);

async function isTicketLifecycleLogChannel(message) {
  if (!message?.guildId || !message?.channelId) return false;
  const config = await getGuildConfig(message.client, message.guildId).catch(() => null);
  return Boolean(
    config
    && (
      String(message.channelId) === String(config.ticketLogsChannelId || '')
      || String(message.channelId) === String(config.ticketTranscriptChannelId || '')
    )
  );
}

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
  const commandName = interaction.commandName
    || canonicalComponentCommand(interaction.customId)
    || '';
  return {
    commandName,
    customId: interaction.customId || '',
    guildId: interaction.guildId || interaction.guild?.id || null,
    channelId: interaction.channelId || interaction.channel?.id || null,
    channel: interaction.channel || null,
  };
}

function messageContext(message) {
  const metadata = message?.interactionMetadata || message?.interaction || null;
  const commandName = metadata?.commandName
    || metadata?.name
    || canonicalComponentCommand(metadata?.customId)
    || canonicalEmbedCommand(message)
    || '';
  return {
    commandName,
    customId: metadata?.customId || '',
    guildId: message?.guildId || message?.guild?.id || null,
    channelId: message?.channelId || message?.channel?.id || null,
    channel: message?.channel || null,
  };
}

function applyPayloadTemplates(payload, source) {
  if (isPrivateReportCasePayload(payload)) return payload;
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

export async function applySavedBlackjackPayloadTemplates(payload, source) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.embeds)) return payload;
  if (String(source?.commandName || '').toLowerCase() !== 'blackjack') return payload;

  const guildId = source.guildId || source.channel?.guildId || source.channel?.guild?.id;
  const channelId = source.channelId || source.channel?.id;
  if (!guildId || !channelId) return payload;

  const embeds = await Promise.all(payload.embeds.map(async embed => {
    const data = embed?.toJSON ? embed.toJSON() : embed;
    if (!isBlackjackEmbed(data)) return embed;
    const decorated = await decorateEmbedWithSavedTemplate(guildId, channelId, embed);
    return decorated.embed;
  }));

  return { ...payload, embeds };
}

// Final Discord payload guard for casino outcomes. This also owns the live
// game presentation after every Builder/template layer so neutral casino
// screens can never fall back to an old blue template.
function enforceCasinoOutcomePresentation(runtimePayload, outgoing, source, method = 'unknown') {
  const command = String(source?.commandName || '').trim().toLowerCase();
  if (!['blackjack', 'baccarat', 'roulette'].includes(command)) return outgoing;
  if (!runtimePayload || typeof runtimePayload !== 'object' || !Array.isArray(runtimePayload.embeds)) return outgoing;
  if (!outgoing || typeof outgoing !== 'object' || !Array.isArray(outgoing.embeds)) return outgoing;

  let protectedCount = 0;
  const embeds = outgoing.embeds.map((embed, index) => {
    const runtimeEmbed = runtimePayload.embeds[index];
    const runtimeData = runtimeEmbed?.toJSON ? runtimeEmbed.toJSON() : runtimeEmbed;
    if (!runtimeData || typeof runtimeData !== 'object') return embed;

    const title = String(runtimeData.title || '').replace(/\s+/g, ' ').trim();
    const normalizedTitle = title.toLowerCase();
    const decorated = embed?.toJSON ? embed.toJSON() : { ...(embed || {}) };

    // Active blackjack/baccarat cards are normal Cloudy game embeds:
    // always white with the Cloudy C at the top-right.
    const liveMatch = normalizedTitle.match(/^(blackjack|baccarat)\s*[—-]\s*bet\b/);
    if (liveMatch?.[1] === command) {
      protectedCount += 1;
      return {
        ...decorated,
        color: 0xFFFFFF,
        thumbnail: {
          url: runtimeData.thumbnail?.url || CLOUDY_LOGO_URL,
        },
      };
    }

    const resultMatch = normalizedTitle.match(/^(blackjack|baccarat|roulette)\s+(win|loss|bust|push)$/);
    if (!resultMatch) return embed;

    const [, game, outcome] = resultMatch;
    const allowed = game === command && (
      (game === 'blackjack' && ['win', 'loss', 'bust', 'push'].includes(outcome))
      || (game === 'baccarat' && ['win', 'loss', 'push'].includes(outcome))
      || (game === 'roulette' && ['win', 'loss'].includes(outcome))
    );
    if (!allowed) return embed;

    protectedCount += 1;
    return {
      ...decorated,
      title: game.charAt(0).toUpperCase() + game.slice(1) + ' ' + outcome,
      color: outcome === 'win' ? 0x00C49D
        : outcome === 'push' ? 0xFFFFFF
          : 0x7A1712,
      thumbnail: {
        url: runtimeData.thumbnail?.url || CLOUDY_LOGO_URL,
      },
    };
  });

  if (protectedCount) {
    logger.warn(
      `[CASINO_OUTGOING] command=${command} method=${method} protected=${protectedCount} title=${embeds[0]?.title || ''} color=${embeds[0]?.color ?? ''}`,
    );
  }

  return { ...outgoing, embeds };
}

function shouldPrepareMessageEdit(message) {
  return Boolean(
    message?.guildId
    && message?.client?.user?.id
    && message.author?.id === message.client.user.id
    && !autoApplyingMessageIds.has(message.id)
    && !isEmbedManagerSaveInProgress(message.id)
    && String(message.content || '').trim() !== SYSTEM_CATALOG_CONTENT,
  );
}

// Button-driven games sometimes update their original Message directly instead
// of going through an Interaction reply. Decorate that payload before Discord
// receives it, so the client never paints the default blue version first.
export function prepareMessageEditPayload(message, payload) {
  if (!shouldPrepareMessageEdit(message)) return payload;
  const source = messageContext(message);
  const outgoing = applyPayloadTemplates(payload, source);
  return enforceCasinoOutcomePresentation(payload, outgoing, source, 'message.edit');
}

function patchMessageEdits() {
  const prototype = Message.prototype;
  if (prototype[MESSAGE_EDIT_PATCH_MARKER] || typeof prototype.edit !== 'function') return;

  const originalEdit = prototype.edit;
  Object.defineProperty(prototype, MESSAGE_EDIT_PATCH_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  prototype.edit = async function cloudyPreStyledMessageEdit(payload, ...args) {
    let outgoing = payload;
    try {
      outgoing = prepareMessageEditPayload(this, payload);
      if (shouldPrepareMessageEdit(this)) {
        outgoing = await applySavedResponsePayloadTemplates(outgoing, messageContext(this));
        void rememberBuilderRuntimePreview(outgoing, messageContext(this)).catch(error => logger.debug(`Builder runtime preview capture skipped: ${error.message}`));
      }
    } catch (error) {
      logger.debug(`[EMBED_BUILDER] Direct message template processing skipped: ${error?.message || error}`);
    }
    return originalEdit.call(this, outgoing, ...args);
  };
}

function capturePayload(payload, source) {
  if (isPrivateReportCasePayload(payload)) return false;
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

async function applyTemplatesToExistingMessage(message, { initialCreation = false } = {}) {
  if (isPrivateReportCasePayload(message)) return false;
  if (PRESERVE_EXISTING_EMBEDS && !initialCreation) return false;
  if (!message?.client?.user?.id || !message.guildId || !message.editable) return false;
  if (message.author?.id !== message.client.user.id) return false;
  if (String(message.content || '').trim() === SYSTEM_CATALOG_CONTENT) return false;
  if (await isTicketLifecycleLogChannel(message)) return false;
  if (isEmbedManagerSaveInProgress(message.id)) return false;
  if (autoApplyingMessageIds.has(message.id)) return false;
  // Fixed moderation/system logs are styled in their own send path too.
  // Ticket lifecycle logs were already excluded above using live guild config.
  if (FIXED_NON_TICKET_LOG_CHANNEL_IDS.has(message.channelId)) return false;

  const source = messageContext(message);
  // Blackjack already receives its stored styling before Discord gets the
  // component reply. A late generic rewrite can otherwise replay a previous
  // hand after the final Win/Loss update.
  if (String(source.commandName || '').toLowerCase() === 'blackjack') return false;
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
  const roulette = { commandName: 'roulette', globalTemplate: true };
  const blackjack = { commandName: 'blackjack', globalTemplate: true };
  const baccarat = { commandName: 'baccarat', globalTemplate: true };

  captureSystemEmbedData({
    title: 'Roulette win',
    description: 'The wheel landed on {dynamic}\n**{dynamic} • {dynamic}**',
    color: 0x00C49D,
    fields: [
      { name: 'Your bet', value: '**{dynamic}** on **{dynamic}**', inline: true },
      { name: 'Payout', value: '**{dynamic}**', inline: true },
      { name: 'Cash balance', value: '**{dynamic}**', inline: true },
    ],
  }, roulette);

  captureSystemEmbedData({
    title: 'Roulette loss',
    description: 'The wheel landed on {dynamic}\n**{dynamic} • {dynamic}**',
    color: 0x7A1712,
    fields: [
      { name: 'Your bet', value: '**{dynamic}** on **{dynamic}**', inline: true },
      { name: 'Result', value: 'Lost **{dynamic}**', inline: true },
      { name: 'Cash balance', value: '**{dynamic}**', inline: true },
    ],
  }, roulette);

  captureSystemEmbedData({
    title: 'Blackjack — Bet $100',
    description: '',
    color: 0xFFFFFF,
    fields: [
      { name: 'Your Hand', value: '{dynamic}\nValue: **{dynamic}**', inline: true },
      { name: 'Dealer Hand', value: '{dynamic}\nValue: **?**', inline: true },
    ],
  }, blackjack);

  for (const title of ['Win', 'Loss', 'Push', 'Bust', 'Blackjack', 'Expired']) {
    captureSystemEmbedData({
      title: `Blackjack ${title.toLowerCase()}`,
      description: 'Payout: **{dynamic}**\nCash balance: **{dynamic}**',
      color: title === 'Win' || title === 'Blackjack' ? 0x00C49D : title === 'Loss' || title === 'Bust' ? 0x7A1712 : title === 'Push' ? 0xFFFFFF : 0xFCFFA1,
      fields: [
        { name: 'Your Hand', value: '{dynamic}\nValue: **{dynamic}**', inline: true },
        { name: 'Dealer Hand', value: '{dynamic}\nValue: **{dynamic}**', inline: true },
      ],
    }, blackjack);
  }

  captureSystemEmbedData({
    title: 'Baccarat — Bet $100',
    description: 'Choose where to place your bet.',
    color: 0xFFFFFF,
  }, baccarat);

  const baccaratFields = [
    { name: 'Player Hand', value: '{dynamic}\nValue: **{dynamic}**', inline: true },
    { name: 'Banker Hand', value: '{dynamic}\nValue: **{dynamic}**', inline: true },
  ];
  const baccaratResults = [
    ['win', 'You chose **{dynamic}**. Winner: **{dynamic}**\nPayout: **{dynamic}**\nCash balance: **{dynamic}**', baccaratFields],
    ['loss', 'You chose **{dynamic}**. Winner: **{dynamic}**\nYou lost **{dynamic}**\nCash balance: **{dynamic}**', baccaratFields],
    ['push', 'You chose **{dynamic}**. Winner: **{dynamic}**\nTie, your **{dynamic}** bet was returned.\nCash balance: **{dynamic}**', baccaratFields],
    ['expired', 'Game expired. **{dynamic}** was returned.', []],
  ];
  for (const [outcome, description, fields] of baccaratResults) {
    captureSystemEmbedData({
      title: `Baccarat ${outcome}`,
      description,
      color: outcome === 'win' ? 0x00C49D
        : outcome === 'loss' ? 0x7A1712
          : outcome === 'push' ? 0xFFFFFF
            : 0xFCFFA1,
      ...(fields.length ? { fields } : {}),
    }, baccarat);
  }
}

export async function applySavedResponsePayloadTemplates(payload, source) {
  if (isPrivateReportCasePayload(payload)) return payload;
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.embeds)) return payload;
  const guildId = source?.guildId || source?.channel?.guild?.id;
  const channelId = source?.channelId || source?.channel?.id;
  if (!guildId || !channelId) return payload;
  if (payload.embeds.some(embed => /^(?:message builder|modify embed)$/i.test(String(embed?.title || embed?.data?.title || '')))) return payload;
  await warmSavedEmbedTemplateScopes(guildId, [channelId]);
  return { ...payload, embeds: payload.embeds.map(embed => {
    const data = embed?.toJSON ? embed.toJSON() : embed;
    if (/^cloudy template key:/i.test(String(data?.author?.name || ''))) return embed;
    return getCachedSavedEmbedTemplateData(guildId, channelId, data, { responseIdentity: balanceResponseIdentity(data, source) }).data;
  }) };
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
          outgoing = await applySavedResponsePayloadTemplates(outgoing, source);
          void rememberBuilderRuntimePreview(outgoing, source).catch(error => logger.debug(`Builder runtime preview capture skipped: ${error.message}`));
          outgoing = enforceCasinoOutcomePresentation(payload, outgoing, source, method);
        } catch (error) {
          logger.debug(`[EMBED_BUILDER] Response template processing skipped for ${method}: ${error?.message || error}`);
        }
        return original(rememberTransientPayloadIntent(payload, outgoing), ...args);
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
          // Ticket lifecycle logs have their own Builder/template path and
          // fixed colors. Generic history replay must never restyle or capture
          // them as ordinary response templates.
          if (await isTicketLifecycleLogChannel(message)) continue;

          // Reapply Builder styling to recent interaction replies too. These
          // replies do not pass through the normal registry on creation.
          if (!isBlackjackEmbed(message.embeds?.[0])) {
            await applySavedEmbedTemplates(message);
          }
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
    patchMessageEdits();
    seedKnownGameResponses();

    client.on(Events.MessageCreate, async message => {
      if (String(message?.content || '').trim() === SYSTEM_CATALOG_CONTENT) return;
      try {
        if (await isTicketLifecycleLogChannel(message)) return;
        captureMessage(message);
        await applyTemplatesToExistingMessage(message, { initialCreation: true });
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
      if (isEmbedManagerSaveInProgress(message.id)) return;
      if (autoApplyingMessageIds.has(message.id)) return;

      try {
        if (await isTicketLifecycleLogChannel(message)) return;
        captureMessage(message);
        await applyTemplatesToExistingMessage(message);
      } catch (error) {
        logger.debug(`[EMBED_BUILDER] Live message update processing skipped: ${error?.message || error}`);
      }
    });

    // Live responses are captured as they are created/updated. A full guild
    // history sweep is expensive and is not needed on every deploy.
    if (process.env.CLOUDY_HISTORY_BOOTSTRAP === '1') {
      const timer = setTimeout(() => {
        void scanRecentBotResponses(client).catch(error => {
          logger.warn(`[EMBED_BUILDER] Full response history sync failed: ${error.message}`);
        });
      }, STARTUP_SCAN_DELAY_MS);
      timer.unref?.();
    }

    logger.warn('[EMBED_BUILDER] Automatic response templates enabled: saved titles, text, fields, colors, footer and media are reused while live values stay dynamic.');
  },
};
