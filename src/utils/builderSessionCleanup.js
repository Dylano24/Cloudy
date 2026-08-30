import { InteractionWebhook, Message } from 'discord.js';

export const BUILDER_SESSION_IDLE_MS = 60_000;
const LEGACY_BUILDER_IDLE_MS = 30 * 60_000;
const PENDING_MANAGER_PARENT_TTL_MS = 15_000;
const PATCH_MARKER = Symbol.for('cloudy.builder-session-cleanup');
const BUILDER_TITLES = new Set(['message builder', 'modify embed']);
const sessionTimers = new Map();
const sessionDeleters = new Map();
const sessionCollectors = new Map();
const parentSessions = new Map();
const pendingManagerParents = new Map();

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

function resetBuilderSessionCollector(messageId) {
  const collector = sessionCollectors.get(String(messageId || ''));
  if (!collector || collector.ended) return;
  collector.resetTimer?.({ idle: BUILDER_SESSION_IDLE_MS });
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

export async function deleteBuilderSessionMessage(message) {
  if (!message?.id) return false;

  const key = String(message.id);
  clearBuilderSessionTimer(key);
  sessionCollectors.delete(key);
  parentSessions.delete(key);
  const deleteThroughWebhook = sessionDeleters.get(key);
  sessionDeleters.delete(key);

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
  clearBuilderSessionTimer(key);
  resetBuilderSessionCollector(key);

  const timer = setTimeout(() => {
    sessionTimers.delete(key);
    void deleteBuilderSessionMessage(message);
  }, BUILDER_SESSION_IDLE_MS);
  timer.unref?.();
  sessionTimers.set(key, timer);

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
    const managedBuilder = isBuilderSessionMessage(this)
      && Number(options?.idle) === LEGACY_BUILDER_IDLE_MS;
    const collectorOptions = managedBuilder
      ? { ...options, idle: BUILDER_SESSION_IDLE_MS }
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
      if (shouldDeleteBuilderSessionOnCollectorEnd(reason)) {
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
