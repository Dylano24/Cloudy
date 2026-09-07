import { Events, MessageFlags } from 'discord.js';
import { normalizeCloudyMessage } from '../services/cloudyBrandingService.js';
import {
  isRegistrableCloudyEmbedMessage,
  registerCloudyEmbedMessage,
} from '../services/embedRegistryService.js';
import { applySavedEmbedTemplates } from '../services/embedTemplateService.js';
import { isBlackjackEmbed } from '../utils/blackjackEmbedPresentation.js';
import { COMMUNITY_REVIEWS_CHANNEL_ID } from '../services/staffReviewsService.js';
import { scheduleTransientMessageDeletion } from '../utils/transientResponse.js';

const REVIEW_FOOTER_TEXT = '© Cloudy Inc. • Quality. Innovation. Performance.';
const FIXED_LOG_CHANNEL_IDS = new Set([
  '1539375620885323826',
  '1539371111240831078',
  '1539259457404412036',
  '1539371572442435646',
]);

async function ensurePublishedReviewFooter(message) {
  const embed = message.embeds?.[0];
  if (!embed) return;

  const data = embed.toJSON?.() || {};
  const footerText = String(data.footer?.text || '');
  const footerIcon = String(data.footer?.icon_url || '');

  if (footerText === REVIEW_FOOTER_TEXT && !footerIcon) return;

  await message.edit({
    embeds: [{
      ...data,
      footer: {
        text: REVIEW_FOOTER_TEXT,
      },
    }],
  }).catch(() => {});
}

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

    scheduleTransientMessageDeletion(message);

    // Dedicated logs are already decorated before they are sent. A second
    // generic pass here can cross-match another log template in the channel
    // and change a timeout into an untimeout (or vice versa).
    if (FIXED_LOG_CHANNEL_IDS.has(message.channelId)) {
      if (isRegistrableCloudyEmbedMessage(message)) {
        await registerCloudyEmbedMessage(message, 'automatic');
      }
      return;
    }

    // Blackjack is styled before its component reply is sent. Do not rewrite
    // it later from a stale opening-hand snapshot.
    // Published reviews contain a live custom emoji. Reapplying a saved
    // template here can strip its emoji ID and leave only `:emoji_name:`.
    const isPublishedStaffReview = message.channelId === COMMUNITY_REVIEWS_CHANNEL_ID;
    if (isPublishedStaffReview) {
      await ensurePublishedReviewFooter(message);
      return;
    }

    const matchedTemplate = isBlackjackEmbed(message.embeds?.[0])
      || await applySavedEmbedTemplates(message, { initialCreation: true });
    if (!matchedTemplate) await normalizeCloudyMessage(message, { ensureFooter: true, initialCreation: true });
    if (isRegistrableCloudyEmbedMessage(message)) {
      await registerCloudyEmbedMessage(message, 'automatic');
    }
  },
};
