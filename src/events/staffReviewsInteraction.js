import { Events, MessageFlags } from 'discord.js';
import {
  COMMUNITY_REVIEWS_CHANNEL_ID,
  STAFF_REVIEW_LOGO_NAME,
  STAFF_REVIEW_LOGO_PATH,
  STAFF_REVIEW_MEMBER_ID,
  STAFF_REVIEW_MODAL_ID,
  STAFF_REVIEW_RATING_ID,
  buildPublishedReview,
  buildRatingPrompt,
  buildStaffReviewModal,
  getReviewMember,
  isOwnerReviewTarget,
  rememberRating,
  rememberReviewMember,
  takeReviewContext,
} from '../services/staffReviewsService.js';

const REVIEW_CONFIRMATION_TTL_MS = 10 * 1000;

export default {
  name: Events.InteractionCreate,
  once: false,

  /**
   * Enforce the staff-review flow: Owner member -> rating -> written review.
   */
  async execute(interaction) {
    if (interaction.isStringSelectMenu?.() && interaction.customId === STAFF_REVIEW_MEMBER_ID) {
      const memberId = interaction.values?.[0];
      if (!memberId || memberId === 'none') return;

      const validTarget = await isOwnerReviewTarget(interaction.guild, memberId);
      if (!validTarget) {
        await interaction.reply({
          content: 'That member is no longer available for staff reviews. Please choose another member.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      rememberReviewMember(interaction.user.id, memberId);
      await interaction.reply({
        ...buildRatingPrompt(memberId),
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    if (interaction.isStringSelectMenu?.() && interaction.customId === STAFF_REVIEW_RATING_ID) {
      const memberId = getReviewMember(interaction.user.id);
      if (!memberId) {
        await interaction.reply({
          content: 'Please choose the staff member first.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      const validTarget = await isOwnerReviewTarget(interaction.guild, memberId);
      if (!validTarget) {
        await interaction.reply({
          content: 'That member is no longer available for staff reviews. Please start again.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      const rating = Number(interaction.values?.[0]);
      if (!rating || rating < 1 || rating > 5) return;

      rememberRating(interaction.user.id, rating);
      await interaction.showModal(buildStaffReviewModal());
      return;
    }

    if (!interaction.isModalSubmit?.() || interaction.customId !== STAFF_REVIEW_MODAL_ID) return;

    const reviewContext = takeReviewContext(interaction.user.id);
    if (!reviewContext?.memberId || !reviewContext?.rating) {
      await interaction.reply({
        content: 'Please choose the staff member and star rating again before submitting a review.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    const comment = interaction.fields.getTextInputValue('staff_review_comment')?.trim();
    if (!comment) return;

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch {
      return;
    }

    const validTarget = await isOwnerReviewTarget(interaction.guild, reviewContext.memberId);
    if (!validTarget) {
      await interaction.editReply({
        content: 'That member is no longer available for staff reviews. Please start again.',
      }).catch(() => {});
      return;
    }

    const channel = await interaction.client.channels.fetch(COMMUNITY_REVIEWS_CHANNEL_ID).catch(() => null);
    if (!channel?.isSendable?.()) {
      await interaction.editReply({
        content: 'The community reviews channel is currently unavailable.',
      }).catch(() => {});
      return;
    }

    const publishedMessage = await channel.send({
      embeds: [buildPublishedReview(
        interaction,
        reviewContext.rating,
        comment,
        reviewContext.memberId,
      )],
      files: [{
        attachment: STAFF_REVIEW_LOGO_PATH,
        name: STAFF_REVIEW_LOGO_NAME,
      }],
      allowedMentions: { parse: [] },
    }).catch(() => null);

    if (!publishedMessage) {
      await interaction.editReply({
        content: 'The staff review could not be published right now. Please try again.',
      }).catch(() => {});
      return;
    }

    await interaction.editReply({
      content: 'Your staff review has been published. Thank you!',
    }).catch(() => {});

    const timer = setTimeout(async () => {
      if (interaction.replied || interaction.deferred) {
        await interaction.deleteReply().catch(() => {});
      }
    }, REVIEW_CONFIRMATION_TTL_MS);

    timer.unref?.();
  },
};
