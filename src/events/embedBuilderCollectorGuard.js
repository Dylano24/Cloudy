import { Events, Message } from 'discord.js';
import { logger } from '../utils/logger.js';

const PATCH_FLAG = Symbol.for('cloudy.embedBuilderCollectorGuard');

function isEmbedBuilderMessage(message) {
  return Boolean(message?.components?.some(row =>
    row?.components?.some(component => {
      const customId = component?.customId || component?.data?.custom_id || '';
      return String(customId).startsWith('simple_embed_');
    }),
  ));
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute() {
    if (Message.prototype[PATCH_FLAG]) return;

    const originalCreateCollector = Message.prototype.createMessageComponentCollector;
    if (typeof originalCreateCollector !== 'function') return;

    Message.prototype.createMessageComponentCollector = function createPersistentEmbedBuilderCollector(options = {}) {
      if (!isEmbedBuilderMessage(this)) {
        return originalCreateCollector.call(this, options);
      }

      // Embed-builder controls must stay usable for as long as the message itself exists.
      // Discord otherwise shows "didn't respond in time" when a local collector expires.
      const persistentOptions = { ...options };
      delete persistentOptions.time;
      delete persistentOptions.idle;
      return originalCreateCollector.call(this, persistentOptions);
    };

    Object.defineProperty(Message.prototype, PATCH_FLAG, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });

    logger.info('[EMBED_BUILDER] Persistent component collector guard enabled.');
  },
};
