import { Events, MessageFlags } from 'discord.js';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';
import { ensureStaffReviewStarEmoji } from '../services/staffReviewsService.js';
import {
  SERVICE_REVIEWS_CHANNEL_ID, SERVICE_REVIEW_MODAL_ID,
  SERVICE_REVIEW_RATING_ID, SERVICE_REVIEW_SELECT_ID,
  SERVICE_REVIEW_TYPES, buildPublishedServiceReview,
  serviceReviewModal, serviceReviewPanelRows,
} from '../services/serviceReviewsService.js';
import { logger } from '../utils/logger.js';

const REVIEW_CONFIRMATION_MS = 10_000;
const SELECTION_TTL_MS = 15 * 60_000;
const selectedServices = new Map();

function selectionKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

function rememberSelection(interaction, type) {
  const now = Date.now();
  for (const [key, item] of selectedServices) {
    if (now - item.at > SELECTION_TTL_MS) selectedServices.delete(key);
  }
  selectedServices.set(selectionKey(interaction), { type, at: now });
}

function selectedService(interaction) {
  const key = selectionKey(interaction);
  const selection = selectedServices.get(key);
  if (!selection || Date.now() - selection.at > SELECTION_TTL_MS) {
    selectedServices.delete(key);
    return null;
  }
  return selection.type;
}

function clearSelection(interaction) {
  selectedServices.delete(selectionKey(interaction));
}

export default {
  name: Events.InteractionCreate,
  once: false,
  async execute(interaction) {
    const customId = interaction.customId || '';
    if (customId !== SERVICE_REVIEW_SELECT_ID
      && customId !== SERVICE_REVIEW_RATING_ID
      && !customId.startsWith(`${SERVICE_REVIEW_RATING_ID}:`)
      && !customId.startsWith(`${SERVICE_REVIEW_MODAL_ID}:`)) return;
    // No other Cloudy guild or channel may publish service reviews.
    if (interaction.guildId !== '1532882647838228723'
      || interaction.channelId !== SERVICE_REVIEWS_CHANNEL_ID) return;

    const isSelect = interaction.isStringSelectMenu?.();
    if (isSelect && customId === SERVICE_REVIEW_SELECT_ID) {
      const type = interaction.values?.[0];
      if (!Object.hasOwn(SERVICE_REVIEW_TYPES, type)) return;
      // Same in-panel two-step flow as Staff Reviews: update the original
      // message, never create a separate ephemeral rating menu per click.
      try {
        await interaction.deferUpdate();
      } catch {
        return;
      }
      rememberSelection(interaction, type);
      try {
        await interaction.editReply({ components: serviceReviewPanelRows(type) });
      } catch (error) {
        clearSelection(interaction);
        logger.warn('[SERVICE_REVIEWS] Could not enable rating menu:', error);
      }
      return;
    }

    if (isSelect && (customId === SERVICE_REVIEW_RATING_ID
      || customId.startsWith(`${SERVICE_REVIEW_RATING_ID}:`))) {
      // Legacy private rating controls can finish an already-started review,
      // but new choices always use the two controls on the public panel.
      const legacyType = customId.startsWith(`${SERVICE_REVIEW_RATING_ID}:`)
        ? customId.slice(SERVICE_REVIEW_RATING_ID.length + 1) : null;
      const type = legacyType || selectedService(interaction);
      if (!type || !Object.hasOwn(SERVICE_REVIEW_TYPES, type)) {
        await interaction.reply({
          content: 'Choose a product or service first.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }
      const rating = Number(interaction.values?.[0]);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return;
      try {
        await interaction.showModal(serviceReviewModal(type, rating));
      } catch {
        return;
      }
      clearSelection(interaction);
      // Immediately reset the same public panel for the next review.
      if (customId === SERVICE_REVIEW_RATING_ID && interaction.message?.edit) {
        await interaction.message.edit({ components: serviceReviewPanelRows() }).catch(error => {
          logger.warn('[SERVICE_REVIEWS] Could not reset rating menu:', error);
        });
      }
      return;
    }

    if (!interaction.isModalSubmit?.() || !customId.startsWith(`${SERVICE_REVIEW_MODAL_ID}:`)) return;
    const [, type, rawRating] = customId.split(':');
    const rating = Number(rawRating);
    if (!Object.hasOwn(SERVICE_REVIEW_TYPES, type) || !Number.isInteger(rating)
      || rating < 1 || rating > 5) return;

    const comment = interaction.fields?.getTextInputValue('service_review_comment')?.trim();
    if (!comment || comment.length < 3 || comment.length > 1000) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const channel = await resolveCloudyChannel(interaction.client, 'servicePostedReviews', {
        guild: interaction.guild, textOnly: true,
      });
      if (!channel?.isSendable?.() || channel.id !== '1568553442870558720') {
        await interaction.editReply({ content: 'The service posted reviews channel is unavailable.' });
        return;
      }
      const emoji = await ensureStaffReviewStarEmoji(interaction.guild);
      await channel.send({
        embeds: [buildPublishedServiceReview(interaction, type, rating, comment, emoji)],
        allowedMentions: { parse: [] },
      });
      await interaction.editReply({ content: 'Your review has been published. Thank you!' });
      const timer = setTimeout(() => { void interaction.deleteReply().catch(() => {}); }, REVIEW_CONFIRMATION_MS);
      timer.unref?.();
    } catch (error) {
      logger.error('[SERVICE_REVIEWS] Could not publish:', error);
      await interaction.editReply({ content: 'The review could not be published. Please try again.' }).catch(() => {});
    }
  },
};
