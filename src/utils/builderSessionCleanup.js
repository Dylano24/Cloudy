import { AsyncLocalStorage } from 'node:async_hooks';
import { InteractionWebhook, Message } from 'discord.js';

export const BUILDER_SESSION_IDLE_MS = 5 * 60_000;
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

export function isBuilderSessionMessage(message) {
  return Boolean(
    message?.id
    && Array.isArray(message?.embeds)
    && message.embeds.some(embed => BUILDER_TITLES.has(embedTitle(embed)))
  );
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

export function registerBuilderSessionCollector(message, collector) {
  if (!isBuilderSessionMessage(message) || !collector) return false;
  sessionCollectors.set(String(message.id), collector);
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

    // Closing/leaving the editor starts a fresh five-minute inactivity window.
    touchBuilderSessionMessage(message);
  }
  return true;
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
  clearBuilderSessionTimer(key);
  const collector = sessionCollectors.get(key);
  sessionCollectors.delete(key);
  parentSessions.delete(key);
  removeMessageFromHolds(key);
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

  return message.delete?.()
    .then(() => true)
    .catch(() => false) ?? false;
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
    collector?.resetTimer?.({ idle: null });
    holdBuilderSessionMessage(message, activeHoldId, deleteMessage);
  } else if (isBuilderSessionHeld(key)) {
    collector?.resetTimer?.({ idle: null });
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
        void deleteBuilderSessionMessage(this);
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
