import { Events, MessageFlags } from 'discord.js';
import { normalizeCloudyMessage } from '../services/cloudyBrandingService.js';
import {
  isRegistrableCloudyEmbedMessage,
  registerCloudyEmbedMessage,
} from '../services/embedRegistryService.js';
import { applySavedEmbedTemplates } from '../services/embedTemplateService.js';
import { isBlackjackEmbed } from '../utils/blackjackEmbedPresentation.js';

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(message) {
    if (!message?.client?.user?.id) return;
    if (message.author?.id !== message.client.user.id) return;
    // Slash-command replies (games, tickets, errors) are still real bot
    // embeds. They must receive a saved Builder template even when they are
    // intentionally excluded from the Builder registry itself.
    if (message.flags?.has?.(MessageFlags.Ephemeral)) return;

    // Blackjack is styled before its component reply is sent. Do not rewrite
    // it later from a stale opening-hand snapshot.
    const matchedTemplate = isBlackjackEmbed(message.embeds?.[0]) || await applySavedEmbedTemplates(message);
    if (!matchedTemplate) await normalizeCloudyMessage(message, { ensureFooter: true });
    if (isRegistrableCloudyEmbedMessage(message)) {
      await registerCloudyEmbedMessage(message, 'automatic');
    }
  },
};
