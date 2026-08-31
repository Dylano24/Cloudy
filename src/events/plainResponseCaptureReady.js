import { Events } from 'discord.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { applyPlainResponseTemplate } from '../services/systemEmbedCatalogService.js';
import { logger } from '../utils/logger.js';

const PATCH_MARKER = Symbol.for('cloudy.plainResponseCapture');

export default {
  name: Events.ClientReady,
  once: true,

  execute() {
    if (InteractionHelper[PATCH_MARKER]) return;

    const originalPatch = InteractionHelper.patchInteractionResponses.bind(InteractionHelper);
    InteractionHelper.patchInteractionResponses = function patchCloudyPlainResponses(interaction) {
      originalPatch(interaction);
      if (!interaction || interaction.__cloudyPlainResponsePatched) return;

      for (const method of ['reply', 'editReply', 'followUp']) {
        const original = interaction[method]?.bind(interaction);
        if (!original) continue;
        interaction[method] = async (payload) => original(applyPlainResponseTemplate(payload, interaction));
      }

      interaction.__cloudyPlainResponsePatched = true;
    };

    Object.defineProperty(InteractionHelper, PATCH_MARKER, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    logger.info('Plain bot response capture enabled.');
  },
};
