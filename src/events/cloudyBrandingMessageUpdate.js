import { Events } from 'discord.js';
import { normalizeCloudyMessage } from '../services/cloudyBrandingService.js';
import {
  applySavedEmbedTemplates,
  saveEmbedTemplateDecoration,
} from '../services/embedTemplateService.js';
import {
  isRegistrableCloudyEmbedMessage,
  registerCloudyEmbedMessage,
} from '../services/embedRegistryService.js';

function isWelcomeEmbed(embed) {
  const title = String(embed?.title || '').replace(/\s+/g, ' ').trim();
  return /^welcome to cloudy(?:\s+inc\.?)?$/i.test(title);
}

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(oldMessage, newMessage) {
    if (!newMessage?.client?.user?.id) return;

    const message = newMessage.partial
      ? await newMessage.fetch().catch(() => null)
      : newMessage;

    if (!message) return;
    if (message.author?.id !== message.client.user.id) return;
    if (!isRegistrableCloudyEmbedMessage(message)) return;

    const oldEmbeds = oldMessage?.embeds || [];
    const welcomeEmbed = message.embeds?.find(isWelcomeEmbed) || null;

    // Welcome messages are repeated per member, but they represent one editable
    // template. Persist edits made to any welcome message so every future
    // welcome inherits the same title/color/footer/logo/media decoration.
    if (welcomeEmbed) {
      const oldWelcome = oldEmbeds.find(isWelcomeEmbed) || null;
      const oldData = oldWelcome?.toJSON?.() || {};
      const newData = welcomeEmbed.toJSON?.() || {};

      const thumbnailChanged = (oldData.thumbnail?.url || null) !== (newData.thumbnail?.url || null);
      const imageChanged = (oldData.image?.url || null) !== (newData.image?.url || null);

      await saveEmbedTemplateDecoration(
        message.guildId,
        message.channelId,
        ['Welcome to Cloudy', 'Welcome to Cloudy Inc.'],
        newData,
        {
          applyThumbnail: thumbnailChanged,
          applyImage: imageChanged,
        },
      );
    }

    const matchedTemplate = await applySavedEmbedTemplates(message);
    if (!matchedTemplate) await normalizeCloudyMessage(message, { ensureFooter: true });
    await registerCloudyEmbedMessage(message, 'automatic-update');
  },
};
