import { Events } from 'discord.js';
import { normalizeCloudyMessage } from '../services/cloudyBrandingService.js';
import {
  isRegistrableCloudyEmbedMessage,
  registerCloudyEmbedMessage,
} from '../services/embedRegistryService.js';
import { applySavedEmbedTemplates } from '../services/embedTemplateService.js';

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(message) {
    if (!message?.client?.user?.id) return;
    if (message.author?.id !== message.client.user.id) return;
    if (!isRegistrableCloudyEmbedMessage(message)) return;

    const matchedTemplate = await applySavedEmbedTemplates(message);
    if (!matchedTemplate) await normalizeCloudyMessage(message, { ensureFooter: true });
    await registerCloudyEmbedMessage(message, 'automatic');
  },
};
