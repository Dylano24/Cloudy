import { InteractionWebhook, Message } from 'discord.js';

export const BUILDER_SESSION_IDLE_MS = 2 * 60_000;
const LEGACY_BUILDER_IDLE_MS = 30 * 60_000;
const PATCH_MARKER = Symbol.for('cloudy.builder-session-cleanup');
const BUILDER_TITLES = new Set(['message builder', 'modify embed']);
const sessionTimers = new Map();

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

async function deleteBuilderSessionMessage(message) {
  if (!message?.id) return;
  clearBuilderSessionTimer(message.id);
  await message.delete?.().catch(() => {});
}

export function touchBuilderSessionMessage(message) {
  if (!isBuilderSessionMessage(message)) return false;

  const key = String(message.id);
  clearBuilderSessionTimer(key);

  const timer = setTimeout(() => {
    sessionTimers.delete(key);
    void message.delete?.().catch(() => {});
  }, BUILDER_SESSION_IDLE_MS);
  timer.unref?.();
  sessionTimers.set(key, timer);
  return true;
}

export function installBuilderSessionCleanup() {
  if (Message.prototype[PATCH_MARKER]) return;

  const originalCreateCollector = Message.prototype.createMessageComponentCollector;
  const originalWebhookSend = InteractionWebhook.prototype.send;
  const originalWebhookEditMessage = InteractionWebhook.prototype.editMessage;

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
    touchBuilderSessionMessage(message);
    return message;
  };

  InteractionWebhook.prototype.editMessage = async function editBuilderSessionMessage(...args) {
    const message = await originalWebhookEditMessage.apply(this, args);
    touchBuilderSessionMessage(message);
    return message;
  };
}
