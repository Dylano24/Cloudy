import { Events } from 'discord.js';
import { applySavedEmbedTemplates } from '../services/embedTemplateService.js';
import { registerCloudyEmbedMessage } from '../services/embedRegistryService.js';
import { logger } from '../utils/logger.js';

const SYSTEM_CATALOG_CONTENT = 'System & error embed templates';

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(message) {
    if (!message?.guildId || !message?.client?.user?.id || !message?.embeds?.length) return;
    if (message.author?.id !== message.client.user.id) return;
    if (String(message.content || '').trim() === SYSTEM_CATALOG_CONTENT) return;
    if (!message.editable) return;

    const applied = await applySavedEmbedTemplates(message).catch(error => {
      logger.warn(`[EMBED_BUILDER] Future-message template apply failed: ${error.message}`);
      return false;
    });
    if (!applied) return;

    const refreshed = await message.channel?.messages?.fetch?.(message.id).catch(() => null);
    if (!refreshed) return;
    void registerCloudyEmbedMessage(refreshed, 'saved-template-runtime')
      .catch(error => logger.debug(`[EMBED_BUILDER] Runtime template registry refresh skipped: ${error.message}`));
  },
};