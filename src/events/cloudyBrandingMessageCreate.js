import { Events, MessageFlags } from 'discord.js';
import { normalizeCloudyMessage } from '../services/cloudyBrandingService.js';
import {
  isRegistrableCloudyEmbedMessage,
  registerCloudyEmbedMessage,
} from '../services/embedRegistryService.js';
import { applySavedEmbedTemplates } from '../services/embedTemplateService.js';
import { isBlackjackEmbed } from '../utils/blackjackEmbedPresentation.js';
import { COMMUNITY_REVIEWS_CHANNEL_ID } from '../services/staffReviewsService.js';

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
    // Published reviews contain a live custom emoji. Reapplying a saved
    // template here can strip its emoji ID and leave only `:emoji_name:`.
    const isPublishedStaffReview = message.channelId === COMMUNITY_REVIEWS_CHANNEL_ID;
    const matchedTemplate = isBlackjackEmbed(message.embeds?.[0])
      || isPublishedStaffReview
      || await applySavedEmbedTemplates(message);
    if (!matchedTemplate) await normalizeCloudyMessage(message, { ensureFooter: true });
    if (!isPublishedStaffReview && isRegistrableCloudyEmbedMessage(message)) {
      await registerCloudyEmbedMessage(message, 'automatic');
    }
  },
};
