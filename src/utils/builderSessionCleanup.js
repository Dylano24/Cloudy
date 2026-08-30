import { InteractionWebhook, Message } from 'discord.js';

export const BUILDER_SESSION_IDLE_MS = 60_000;
const LEGACY_BUILDER_IDLE_MS = 30 * 60_000;
const PATCH_MARKER = Symbol.for('cloudy.builder-session-cleanup');
const BUILDER_TITLES = new Set(['message builder', 'modify embed']);
const sessionTimers = new Map();
const sessionDeleters = new Map();

function embedTitle(embed) {
  return String(embed?.title ?? embed?.data?.title ?? '').trim().toLowerCase();
}

export function isBuilderSessionMessage(message) {
  return Boolean(
    message?.id
    && Array.isArray(message?.embeds)
    && message.embeds.some(embed => BUILDER_TITLES.has(embedTitle(embed)))
  );
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

export async function deleteBuilderSessionMessage(message) {
  if (!message?.id) return false;

  const key = String(message.id);
  clearBuilderSessionTimer(key);
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

export function touchBuilderSessionMessage(message, deleteMessage = null) {
  if (!isBuilderSessionMessage(message)) return false;

  const key = String(message.id);
  if (deleteMessage) registerSessionDeleter(message, deleteMessage);
  clearBuilderSessionTimer(key);

  const timer = setTimeout(() => {
    sessionTimers.delete(key);
    void deleteBuilderSessionMessage(message);
  }, BUILDER_SESSION_IDLE_MS);
  timer.unref?.();
  sessionTimers.set(key, timer);
  return true;
}

function touchWebhookMessage(webhook, message) {
  return touchBuilderSessionMessage(
    message,
    () => webhook.deleteMessage(message.id),
  );
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

    touchBuilderSessionMessage(this);

    collector.on('collect', () => {
      touchBuilderSessionMessage(this);
      collector.resetTimer?.({ idle: BUILDER_SESSION_IDLE_MS });
    });

    collector.on('end', (_collected, reason) => {
      if (reason === 'idle') {
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
