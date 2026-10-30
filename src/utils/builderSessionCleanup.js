import { AsyncLocalStorage } from 'node:async_hooks';
import { InteractionWebhook, Message } from 'discord.js';
import { rememberInteractionMessage } from '../services/deletionAttributionService.js';

// The Embed Builder closes after 30 minutes without activity (owner's choice).
export const BUILDER_SESSION_IDLE_MS = 30 * 60_000;
const PREVIOUS_BUILDER_IDLE_MS = 5 * 60_000;
const LEGACY_BUILDER_IDLE_MS = 30 * 60_000;
const PENDING_MANAGER_PARENT_TTL_MS = 15_000;
const PATCH_MARKER = Symbol.for('cloudy.builder-session-cleanup');
const BUILDER_TITLES = new Set(['message builder', 'modify embed']);
const sessionTimers = new Map();
const sessionDeleters = new Map();
const sessionCollectors = new Map();
const parentSessions = new Map();
const pendingManagerParents = new Map();
const sessionHoldIds = new Map();
const holdMessages = new Map();
const editorHoldContext = new AsyncLocalStorage();
const builderPreviewMessageIds = new Set();
// Builder control panel id -> the preview above it. Activity on the panel
// keeps the preview alive too: it has no buttons of its own.
const sessionPreviews = new Map();
// Discord lets Cloudy remove a private Builder only while the link of its last
// click works (15 minutes). A Builder that ended later stays on screen until
// Discord drops it: message id -> its preview id, so a click on it removes it.
const expiredBuilderMessages = new Map();
const EXPIRED_BUILDER_LIMIT = 500;
// These ids have their own listener (Search in Modify embed).
const SELF_HANDLED_BUILDER_IDS = /^simple_embed_(?:title_search$|google_search_page_)/;
// /embedbuilder interactions whose replies are the Builder itself (preview and
// controls). A reply is recognised from its first gateway event on, before
// Cloudy knows its message id.
const builderInteractionIds = new Set();
const BUILDER_INTERACTION_LIMIT = 1000;

function embedTitle(embed) {
  return String(embed?.title ?? embed?.data?.title ?? '').trim().toLowerCase();
}

function hasBuilderTitle(message, title) {
  const expected = String(title || '').trim().toLowerCase();
  return Boolean(
    message?.id
    && Array.isArray(message?.embeds)
    && message.embeds.some(embed => embedTitle(embed) === expected)
  );
}

export function registerBuilderPreviewMessage(message) {
  const id = String(message?.id || message || '').trim();
  if (!id) return false;
  builderPreviewMessageIds.add(id);
  return true;
}

export function unregisterBuilderPreviewMessage(message) {
  const id = String(message?.id || message || '').trim();
  if (!id) return false;
  return builderPreviewMessageIds.delete(id);
}

// The REST branding layer needs to recognize the exact temporary top preview
// so a deliberately absent logo is not silently added back on edit.
export function isRegisteredBuilderPreviewMessageId(messageId) {
  return builderPreviewMessageIds.has(String(messageId || '').trim());
}

export function isBuilderSessionMessage(message) {
  const id = String(message?.id || '').trim();
  if (id && builderPreviewMessageIds.has(id)) return true;

  return Boolean(
    id
    && Array.isArray(message?.embeds)
    && message.embeds.some(embed => BUILDER_TITLES.has(embedTitle(embed)))
  );
}

export function registerBuilderInteraction(interactionId) {
  const id = String(interactionId || '').trim();
  if (!id) return false;
  builderInteractionIds.delete(id);
  builderInteractionIds.add(id);
  while (builderInteractionIds.size > BUILDER_INTERACTION_LIMIT) {
    builderInteractionIds.delete(builderInteractionIds.values().next().value);
  }
  return true;
}

function builderInteractionOf(message) {
  const metadata = message?.interactionMetadata || message?.interaction || null;
  return metadata?.id && builderInteractionIds.has(String(metadata.id)) ? metadata : null;
}

/** Builder UI (preview, controls, Modify embed): never a template, log or Search item. */
export function isBuilderUiMessage(message) {
  return isBuilderSessionMessage(message) || Boolean(builderInteractionOf(message));
}

// The Builder is a normal message in the channel (owner's choice). Only the
// person who opened it can use its controls; anyone else gets a short notice.
export function isForeignBuilderClick(interaction) {
  if (!interaction?.isMessageComponent?.()) return false;
  const customId = String(interaction.customId || '');
  if (!customId.startsWith('simple_embed_') || SELF_HANDLED_BUILDER_IDS.test(customId)) return false;
  const message = interaction.message;
  if (!isBuilderUiMessage(message)) return false;
  const ownerId = String((message.interactionMetadata || message.interaction)?.user?.id || '');
  return Boolean(ownerId && interaction.user?.id && ownerId !== String(interaction.user.id));
}

export function shouldDeleteBuilderSessionOnCollectorEnd(reason) {
  return reason === 'idle' || reason === 'builder-ended';
}

function clearBuilderSessionTimer(messageId) {
  const key = String(messageId || '');
  const timer = sessionTimers.get(key);
  if (timer) clearTimeout(timer);
  sessionTimers.delete(key);
}

function registerSessionDeleter(message, deleteMessage) {
  if (!message?.id || typeof deleteMessage !== 'function') return;
  sessionDeleters.set(String(message.id), deleteMessage);
}

function disableNativeBuilderCollectorIdle(collector) {
  // EMBED_EDITOR_EXACT_OPEN_LEASE_V2: do not rely on resetTimer({ idle: null }) to disable native idle.
  if (collector?._idletimeout) clearTimeout(collector._idletimeout);
  if (collector && '_idletimeout' in collector) collector._idletimeout = null;
  if (collector?.options && typeof collector.options === 'object') {
    delete collector.options.idle;
  }
}

export function registerBuilderSessionCollector(message, collector) {
  if (!isBuilderSessionMessage(message) || !collector) return false;
  disableNativeBuilderCollectorIdle(collector);
  sessionCollectors.set(String(message.id), collector);
  return true;
}

export function linkBuilderSessionPreview(panelMessage, previewMessage) {
  if (!isBuilderSessionMessage(panelMessage) || !previewMessage?.id) return false;
  sessionPreviews.set(String(panelMessage.id), previewMessage);
  return true;
}

export function linkBuilderSessionMessages(parentMessage, childMessage) {
  if (!isBuilderSessionMessage(parentMessage) || !hasBuilderTitle(childMessage, 'modify embed')) {
    return false;
  }

  parentSessions.set(String(childMessage.id), parentMessage);
  return true;
}

function isBuilderSessionHeld(messageId) {
  return (sessionHoldIds.get(String(messageId || ''))?.size || 0) > 0;
}

function holdBuilderSessionMessage(message, holdId, deleteMessage = null) {
  if (!isBuilderSessionMessage(message) || !holdId) return false;

  const key = String(message.id);
  if (deleteMessage) registerSessionDeleter(message, deleteMessage);

  let holds = sessionHoldIds.get(key);
  if (!holds) {
    holds = new Set();
    sessionHoldIds.set(key, holds);
  }
  holds.add(String(holdId));

  let messages = holdMessages.get(String(holdId));
  if (!messages) {
    messages = new Map();
    holdMessages.set(String(holdId), messages);
  }
  messages.set(key, message);

  clearBuilderSessionTimer(key);
  return true;
}

export async function runWithBuilderSessionHold(holdId, callback) {
  if (!holdId || typeof callback !== 'function') {
    return typeof callback === 'function' ? callback() : undefined;
  }
  return editorHoldContext.run({ holdId: String(holdId) }, callback);
}

export function releaseBuilderSessionHold(holdId) {
  const id = String(holdId || '');
  const messages = holdMessages.get(id);
  holdMessages.delete(id);
  if (!messages?.size) return false;

  for (const [key, message] of messages) {
    const holds = sessionHoldIds.get(key);
    holds?.delete(id);
    if (holds?.size) continue;
    sessionHoldIds.delete(key);

    // Closing/leaving the editor starts a fresh Builder inactivity window.
    touchBuilderSessionMessage(message);
  }
  return true;
}

export async function expireBuilderSessionHold(holdId) {
  const id = String(holdId || '');
  const messages = holdMessages.get(id);
  holdMessages.delete(id);
  if (!messages?.size) return false;

  let expiredAny = false;
  for (const [key, message] of messages) {
    const holds = sessionHoldIds.get(key);
    holds?.delete(id);

    // Another editor can legitimately hold the same builder. Only expire the
    // message when this was the final active hold.
    if (holds?.size) continue;
    sessionHoldIds.delete(key);

    expiredAny = true;
    await deleteBuilderSessionMessage(message);
  }

  return expiredAny;
}

function interactionWebhookKey(value) {
  return String(value?.token || value?.webhook?.token || '').trim();
}

function rememberPendingManagerParent(interaction, parentMessage) {
  if (String(interaction?.customId || '') !== 'simple_embed_modify') return;

  const key = interactionWebhookKey(interaction);
  if (!key || !isBuilderSessionMessage(parentMessage)) return;
  pendingManagerParents.set(key, parentMessage);

  const timer = setTimeout(() => {
    if (pendingManagerParents.get(key) === parentMessage) {
      pendingManagerParents.delete(key);
    }
  }, PENDING_MANAGER_PARENT_TTL_MS);
  timer.unref?.();
}

function linkPendingManagerParent(webhook, message) {
  if (!hasBuilderTitle(message, 'modify embed')) return null;

  const key = interactionWebhookKey(webhook);
  if (!key) return null;
  const parentMessage = pendingManagerParents.get(key) || null;
  pendingManagerParents.delete(key);
  if (!parentMessage) return null;

  linkBuilderSessionMessages(parentMessage, message);
  return parentMessage;
}

function removeMessageFromHolds(messageId) {
  const key = String(messageId || '');
  const holds = sessionHoldIds.get(key);
  if (!holds) return;
  for (const holdId of holds) {
    const messages = holdMessages.get(holdId);
    messages?.delete(key);
    if (messages && messages.size === 0) holdMessages.delete(holdId);
  }
  sessionHoldIds.delete(key);
}

export async function deleteBuilderSessionMessage(message) {
  if (!message?.id) return false;

  const key = String(message.id);
  // EMBED_EDITOR_EXACT_OPEN_LEASE_V2: editor/color-picker hold blocks every Builder deletion path.
  if (isBuilderSessionHeld(key)) return false;
  clearBuilderSessionTimer(key);
  const previewMessage = sessionPreviews.get(key);
  const collector = sessionCollectors.get(key);
  sessionCollectors.delete(key);
  parentSessions.delete(key);
  sessionPreviews.delete(key);
  removeMessageFromHolds(key);
  builderPreviewMessageIds.delete(key);
  const deleteThroughWebhook = sessionDeleters.get(key);
  sessionDeleters.delete(key);

  if (collector && !collector.ended) collector.stop?.('builder-cleanup');

  if (deleteThroughWebhook) {
    const deleted = await Promise.resolve()
      .then(() => deleteThroughWebhook())
      .then(() => true)
      .catch(() => false);
    if (deleted) return true;
  }

  const deleted = await (message.delete?.()
    .then(() => true)
    .catch(() => false) ?? false);
  if (!deleted) rememberExpiredBuilderMessage(message, previewMessage);
  return deleted;
}

/** A Builder message Cloudy could not remove any more (Discord's 15-minute link). */
export function rememberExpiredBuilderMessage(message, previewMessage = null) {
  const id = String(message?.id || message || '').trim();
  if (!/^\d+$/.test(id)) return false;
  expiredBuilderMessages.delete(id);
  expiredBuilderMessages.set(id, String(previewMessage?.id || previewMessage || '').trim() || null);
  while (expiredBuilderMessages.size > EXPIRED_BUILDER_LIMIT) {
    expiredBuilderMessages.delete(expiredBuilderMessages.keys().next().value);
  }
  return true;
}

// A click on an expired Builder answers the click and removes that Builder
// with the click's own (new) link, instead of "This interaction failed".
export async function removeExpiredBuilderMessage(interaction) {
  if (!interaction?.isMessageComponent?.()) return false;
  const id = String(interaction.message?.id || '');
  if (!expiredBuilderMessages.has(id) || SELF_HANDLED_BUILDER_IDS.test(String(interaction.customId || ''))) {
    return false;
  }
  const previewId = expiredBuilderMessages.get(id);
  expiredBuilderMessages.delete(id);
  if (previewId) expiredBuilderMessages.delete(previewId);
  if (interaction.deferred || interaction.replied) return true;

  const acknowledged = await interaction.deferUpdate().then(() => true).catch(() => false);
  if (!acknowledged) return true;
  // Cloudy's own private message: its deletion is never logged.
  rememberInteractionMessage(id);
  await Promise.allSettled([
    interaction.deleteReply(),
    previewId ? interaction.webhook?.deleteMessage?.(previewId) : null,
  ]);
  return true;
}

export function touchBuilderSessionMessage(message, deleteMessage = null, visited = new Set()) {
  if (!isBuilderSessionMessage(message)) return false;

  const key = String(message.id);
  if (visited.has(key)) return true;
  visited.add(key);

  if (deleteMessage) registerSessionDeleter(message, deleteMessage);
  const collector = sessionCollectors.get(key);

  const activeHoldId = editorHoldContext.getStore()?.holdId || null;
  if (activeHoldId) {
    disableNativeBuilderCollectorIdle(collector);
    holdBuilderSessionMessage(message, activeHoldId, deleteMessage);
  } else if (isBuilderSessionHeld(key)) {
    disableNativeBuilderCollectorIdle(collector);
    clearBuilderSessionTimer(key);
  } else {
    collector?.resetTimer?.({ idle: BUILDER_SESSION_IDLE_MS });
    clearBuilderSessionTimer(key);

    const timer = setTimeout(() => {
      sessionTimers.delete(key);
      if (!isBuilderSessionHeld(key)) void deleteBuilderSessionMessage(message);
    }, BUILDER_SESSION_IDLE_MS);
    timer.unref?.();
    sessionTimers.set(key, timer);
  }

  const parentMessage = parentSessions.get(key);
  if (parentMessage) {
    touchBuilderSessionMessage(parentMessage, null, visited);
  }
  const previewMessage = sessionPreviews.get(key);
  if (previewMessage) {
    touchBuilderSessionMessage(previewMessage, null, visited);
  }

  return true;
}

function touchWebhookMessage(webhook, message) {
  const parentMessage = linkPendingManagerParent(webhook, message);
  const touched = touchBuilderSessionMessage(
    message,
    () => webhook.deleteMessage(message.id),
  );
  if (parentMessage) touchBuilderSessionMessage(parentMessage);
  return touched;
}

export function installBuilderSessionCleanup() {
  if (Message.prototype[PATCH_MARKER]) return;

  const originalCreateCollector = Message.prototype.createMessageComponentCollector;
  const originalWebhookSend = InteractionWebhook.prototype.send;
  const originalWebhookEditMessage = InteractionWebhook.prototype.editMessage;
  const originalWebhookFetchMessage = InteractionWebhook.prototype.fetchMessage;

  Object.defineProperty(Message.prototype, PATCH_MARKER, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  Message.prototype.createMessageComponentCollector = function createBuilderAwareCollector(options = {}) {
    const requestedIdle = Number(options?.idle);
    const managedBuilder = isBuilderSessionMessage(this)
      && (
        requestedIdle === PREVIOUS_BUILDER_IDLE_MS
        || requestedIdle === LEGACY_BUILDER_IDLE_MS
        || requestedIdle === BUILDER_SESSION_IDLE_MS
      );
    const collectorOptions = managedBuilder
      ? { ...options, idle: undefined }
      : options;
    const collector = originalCreateCollector.call(this, collectorOptions);

    if (!managedBuilder) return collector;

    registerBuilderSessionCollector(this, collector);
    touchBuilderSessionMessage(this);

    collector.on('collect', interaction => {
      rememberPendingManagerParent(interaction, this);
      touchBuilderSessionMessage(this);
    });

    collector.on('end', (_collected, reason) => {
      sessionCollectors.delete(String(this.id));
      if (shouldDeleteBuilderSessionOnCollectorEnd(reason) && !isBuilderSessionHeld(this.id)) {
        // Clears the preview link itself (and remembers it if Discord no
        // longer lets Cloudy remove this Builder).
        void deleteBuilderSessionMessage(this);
      } else {
        sessionPreviews.delete(String(this.id));
      }
    });

    return collector;
  };

  InteractionWebhook.prototype.send = async function sendWithBuilderSessionCleanup(...args) {
    const message = await originalWebhookSend.apply(this, args);
    touchWebhookMessage(this, message);
    return message;
  };

  InteractionWebhook.prototype.editMessage = async function editBuilderSessionMessage(...args) {
    const message = await originalWebhookEditMessage.apply(this, args);
    touchWebhookMessage(this, message);
    return message;
  };

  if (typeof originalWebhookFetchMessage === 'function') {
    InteractionWebhook.prototype.fetchMessage = async function fetchBuilderSessionMessage(...args) {
      const message = await originalWebhookFetchMessage.apply(this, args);
      touchWebhookMessage(this, message);
      return message;
    };
  }
}
