import { Events } from 'discord.js';
import { normalizeCloudyMessage } from '../services/cloudyBrandingService.js';
import { applySavedEmbedTemplates } from '../services/embedTemplateService.js';
import {
  isRegistrableCloudyEmbedMessage,
  registerCloudyEmbedMessage,
} from '../services/embedRegistryService.js';

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(_oldMessage, newMessage) {
    if (!newMessage?.client?.user?.id) return;

    const message = newMessage.partial
      ? await newMessage.fetch().catch(() => null)
      : newMessage;

    if (!message) return;
    if (message.author?.id !== message.client.user.id) return;
    if (!isRegistrableCloudyEmbedMessage(message)) return;

    const matchedTemplate = await applySavedEmbedTemplates(message);
    if (!matchedTemplate) await normalizeCloudyMessage(message, { ensureFooter: true });
    await registerCloudyEmbedMessage(message, 'automatic-update');
  },
};
