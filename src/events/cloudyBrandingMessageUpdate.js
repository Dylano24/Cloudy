import { Events, MessageFlags } from 'discord.js';
import { normalizeCloudyMessage } from '../services/cloudyBrandingService.js';
import {
  applySavedEmbedTemplates,
  saveEmbedTemplateDecoration,
} from '../services/embedTemplateService.js';
import {
  isRegistrableCloudyEmbedMessage,
  registerCloudyEmbedMessage,
} from '../services/embedRegistryService.js';
import { isEmbedManagerSaveInProgress } from '../services/embedManagerService.js';
import {
  applyTicketRuntimeTemplates,
  persistTicketRuntimeTemplates,
} from '../services/ticketRuntimeEmbedTemplateService.js';
import { isBlackjackEmbed } from '../utils/blackjackEmbedPresentation.js';

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
    if (message.flags?.has?.(MessageFlags.Ephemeral)) return;

    // A Builder Save is deliberately ignored by the normal MessageUpdate
    // restyling path. For ticket channels, persist that exact edit first in a
    // stable ticket-runtime scope so future ticket channels inherit it too.
    if (isEmbedManagerSaveInProgress(message.id)) {
      await persistTicketRuntimeTemplates(oldMessage, message);
      return;
    }

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

    const ticketTemplateMatched = await applyTicketRuntimeTemplates(message);

    // The latest Blackjack payload has already been styled before Discord
    // receives it; skipping this late generic edit prevents a flash back to an
    // earlier hand or result.
    const matchedTemplate = isBlackjackEmbed(message.embeds?.[0])
      || ticketTemplateMatched
      || await applySavedEmbedTemplates(message);
    if (!matchedTemplate) await normalizeCloudyMessage(message, { ensureFooter: true });
    if (isRegistrableCloudyEmbedMessage(message)) {
      await registerCloudyEmbedMessage(message, 'automatic-update');
    }
  },
};
