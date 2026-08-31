import { Events } from 'discord.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import {
  applyPlainResponseTemplate,
  captureSystemEmbedData,
} from '../services/systemEmbedCatalogService.js';
import { logger } from '../utils/logger.js';

const PATCH_MARKER = Symbol.for('cloudy.fullResponseCatalogCapture');
const HISTORY_LIMIT = 100;
const STARTUP_SCAN_DELAY_MS = 7000;
const SYSTEM_CATALOG_CONTENT = 'System & error embed templates';

function interactionContext(interaction) {
  if (!interaction) return null;
  return {
    commandName: interaction.commandName || '',
    customId: interaction.customId || '',
    channel: interaction.channel || null,
  };
}

function messageContext(message) {
  const metadata = message?.interactionMetadata || message?.interaction || null;
  return {
    commandName: metadata?.commandName || metadata?.name || '',
    customId: metadata?.customId || '',
    channel: message?.channel || null,
  };
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
      // applyPlainResponseTemplate also registers previously unseen plain-text
      // responses in the same editable response catalog. The returned payload is
      // intentionally ignored here; this hook only observes/captures.
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
        try {
          capturePayload(payload, source);
        } catch (error) {
          logger.debug(`[EMBED_BUILDER] Response capture skipped for ${method}: ${error?.message || error}`);
        }
        return original(payload, ...args);
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
        messagesScanned += 1;
        try {
          if (captureMessage(message)) responsesCaptured += 1;
        } catch (error) {
          logger.debug(`[EMBED_BUILDER] Historical response capture skipped: ${error?.message || error}`);
        }
      }
    }
  }

  logger.info(
    `[EMBED_BUILDER] Full response history sync complete: ${channelsScanned} channels, ${messagesScanned} bot messages checked, ${responsesCaptured} response payloads captured.`,
  );
}

export default {
  name: Events.ClientReady,
  once: true,

  execute(client) {
    patchInteractionCapture();

    client.on(Events.MessageCreate, message => {
      try {
        captureMessage(message);
      } catch (error) {
        logger.debug(`[EMBED_BUILDER] Live message capture skipped: ${error?.message || error}`);
      }
    });

    client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
      const message = newMessage?.partial
        ? await newMessage.fetch().catch(() => null)
        : newMessage;
      if (!message) return;

      try {
        captureMessage(message);
      } catch (error) {
        logger.debug(`[EMBED_BUILDER] Live message update capture skipped: ${error?.message || error}`);
      }
    });

    const timer = setTimeout(() => {
      void scanRecentBotResponses(client).catch(error => {
        logger.warn(`[EMBED_BUILDER] Full response history sync failed: ${error.message}`);
      });
    }, STARTUP_SCAN_DELAY_MS);
    timer.unref?.();

    logger.info('[EMBED_BUILDER] Full response capture enabled for embeds, notifications, interaction replies and message updates.');
  },
};
