import { Events, MessageFlags } from 'discord.js';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';
import { ensureStaffReviewStarEmoji } from '../services/staffReviewsService.js';
import {
  SERVICE_REVIEWS_CHANNEL_ID, SERVICE_REVIEW_MODAL_ID,
  SERVICE_REVIEW_RATING_ID, SERVICE_REVIEW_SELECT_ID,
  SERVICE_REVIEW_TYPES, buildPublishedServiceReview,
  serviceReviewModal, serviceReviewRatingRow,
} from '../services/serviceReviewsService.js';
import { logger } from '../utils/logger.js';

const REVIEW_CONFIRMATION_MS = 10_000;

export default {
  name: Events.InteractionCreate,
  once: false,
  async execute(interaction) {
    const customId = interaction.customId || '';
    if (customId !== SERVICE_REVIEW_SELECT_ID
      && !customId.startsWith(`${SERVICE_REVIEW_RATING_ID}:`)
      && !customId.startsWith(`${SERVICE_REVIEW_MODAL_ID}:`)) return;
    // No other Cloudy guild or channel may publish service reviews.
    if (interaction.guildId !== '1532882647838228723'
      || interaction.channelId !== SERVICE_REVIEWS_CHANNEL_ID) return;

    const isSelect = interaction.isStringSelectMenu?.();
    if (isSelect && customId === SERVICE_REVIEW_SELECT_ID) {
      const type = interaction.values?.[0];
      if (!Object.hasOwn(SERVICE_REVIEW_TYPES, type)) return;
      return interaction.reply({
        components: [serviceReviewRatingRow(type)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (isSelect && customId.startsWith(`${SERVICE_REVIEW_RATING_ID}:`)) {
      const type = customId.split(':')[1];
      const rating = Number(interaction.values?.[0]);
      if (!Object.hasOwn(SERVICE_REVIEW_TYPES, type) || !Number.isInteger(rating)
        || rating < 1 || rating > 5) return;
      return interaction.showModal(serviceReviewModal(type, rating));
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
