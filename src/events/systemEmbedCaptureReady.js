import { EmbedBuilder, Events } from 'discord.js';
import { captureSystemEmbedData } from '../services/systemEmbedCatalogService.js';
import { logger } from '../utils/logger.js';

const PATCH_MARKER = Symbol.for('cloudy.systemEmbedCapture');

export default {
  name: Events.ClientReady,
  once: true,

  execute() {
    if (EmbedBuilder.prototype[PATCH_MARKER]) return;

    const originalToJSON = EmbedBuilder.prototype.toJSON;
    Object.defineProperty(EmbedBuilder.prototype, PATCH_MARKER, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });

    EmbedBuilder.prototype.toJSON = function cloudyObservedEmbedToJSON(...args) {
      const original = originalToJSON.apply(this, args);
      try {
        // Serialization is observation-only. Runtime/system templates are applied
        // in the response pipeline, and saved Builder templates are applied last.
        // Re-applying a template here caused new messages to revert after Save.
        captureSystemEmbedData(original);
      } catch (error) {
        logger.debug(`System embed capture skipped: ${error?.message || error}`);
      }
      return original;
    };

    logger.info('System embed capture enabled (observation-only serialization).');
  },
};
