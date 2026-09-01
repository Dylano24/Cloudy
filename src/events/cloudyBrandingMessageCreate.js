import { Events, MessageFlags } from 'discord.js';
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
    if (!message.guildId || !message.channelId || !message.embeds?.length) return;

    // Interaction/slash replies are intentionally excluded from the persistent
    // Builder registry, but their visible embeds should still inherit any saved
    // style for this channel. Apply the style before deciding whether to register.
    const isEphemeral = message.flags?.has?.(MessageFlags.Ephemeral);
    const matchedTemplate = isEphemeral ? false : await applySavedEmbedTemplates(message);

    if (!isRegistrableCloudyEmbedMessage(message)) return;

    if (!matchedTemplate) await normalizeCloudyMessage(message, { ensureFooter: true });
    await registerCloudyEmbedMessage(message, 'automatic');
  },
};
