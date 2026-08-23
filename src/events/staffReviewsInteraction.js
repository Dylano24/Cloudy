import { Events, MessageFlags } from 'discord.js';
import {
  COMMUNITY_REVIEWS_CHANNEL_ID,
  STAFF_REVIEW_MODAL_ID,
  STAFF_REVIEW_RATING_ID,
  buildPublishedReview,
  buildStaffReviewModal,
  rememberRating,
  takeRating,
} from '../services/staffReviewsService.js';

const REVIEW_CONFIRMATION_TTL_MS = 10 * 1000;

export default {
  name: Events.InteractionCreate,
  once: false,

  async execute(interaction) {
    if (interaction.isStringSelectMenu?.() && interaction.customId === STAFF_REVIEW_RATING_ID) {
      const rating = Number(interaction.values?.[0]);
      if (!rating || rating < 1 || rating > 5) return;

      rememberRating(interaction.user.id, rating);
      await interaction.showModal(buildStaffReviewModal());
      return;
    }

    if (!interaction.isModalSubmit?.() || interaction.customId !== STAFF_REVIEW_MODAL_ID) return;

    const rating = takeRating(interaction.user.id);
    if (!rating) {
      await interaction.reply({
        content: 'Please choose your star rating again before submitting a review.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    const comment = interaction.fields.getTextInputValue('staff_review_comment')?.trim();
    if (!comment) return;

    const channel = await interaction.client.channels.fetch(COMMUNITY_REVIEWS_CHANNEL_ID).catch(() => null);
    if (!channel?.isSendable?.()) {
      await interaction.reply({
        content: 'The community reviews channel is currently unavailable.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    const normalizedRating = Math.max(1, Math.min(5, Number(rating) || 1));
    const stars = '⭐'.repeat(normalizedRating);
    const staffRole = interaction.guild?.roles?.cache?.find(role => role.name.toLowerCase() === 'staff');
    const heading = staffRole ? `${staffRole} ${stars}` : `Staff ${stars}`;

    await channel.send({
      content: heading,
      embeds: [buildPublishedReview(interaction, rating, comment)],
      allowedMentions: staffRole ? { roles: [staffRole.id] } : { parse: [] },
    });

    await interaction.reply({
      content: 'Your staff review has been published. Thank you!',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});

    const timer = setTimeout(async () => {
      if (interaction.replied || interaction.deferred) {
        await interaction.deleteReply().catch(() => {});
      }
    }, REVIEW_CONFIRMATION_TTL_MS);

    timer.unref?.();
  },
};
