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
import { isBuilderOwnedMessage } from '../utils/builderOwnedSends.js';
import { isDedicatedGamblingGuideMessage } from '../utils/gamblingGuideIdentity.js';
import { DEDICATED_MESSAGE_LOG_CHANNEL_IDS } from '../services/messageLogDestination.js';

const REVIEW_FOOTER_TEXT = '© Cloudy Inc. • Quality. Innovation. Performance.';
const FIXED_LOG_CHANNEL_IDS = new Set([
  '1539375620885323826',
  '1539371111240831078',
  '1539259457404412036',
  '1539371572442435646',
  // Staff, Member and AutoMod message logs (footer applied in logEvent).
  ...DEDICATED_MESSAGE_LOG_CHANNEL_IDS,
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

    // An Embed Builder post (or its Reappear move) is owner-authored content.
    // It is registered by the Builder itself with its own identity; generic
    // template/branding passes must never restyle it (colour, logo, title)
    // and a status-like title must not make it a 10-second transient reply.
    if (isBuilderOwnedMessage(message)) return;

    // The Commands guide must never be restyled after its first render.
    // Still register it so the Embed Builder can discover the real message.
    if (isDedicatedGamblingGuideMessage(message)) {
      if (isRegistrableCloudyEmbedMessage(message)) {
        await registerCloudyEmbedMessage(message, 'automatic');
      }
      return;
    }

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
