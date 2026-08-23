import { Events, MessageFlags, PermissionFlagsBits } from 'discord.js';
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
const STAFF_PING_VISIBLE_MS = 1200;

export default {
  name: Events.InteractionCreate,
  once: false,

  /**
   * Handle staff-review rating selections and publish submitted modal reviews.
   */
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

    // Acknowledge the modal immediately so Discord's three-second interaction deadline
    // cannot expire while we fetch the channel/roles and publish the review.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

    const channel = await interaction.client.channels.fetch(COMMUNITY_REVIEWS_CHANNEL_ID).catch(() => null);
    if (!channel?.isSendable?.()) {
      await interaction.editReply({
        content: 'The community reviews channel is currently unavailable.',
      }).catch(() => {});
      return;
    }

    let staffRole = interaction.guild?.roles?.cache?.find(role => role.name.toLowerCase() === 'staff') || null;
    if (!staffRole && interaction.guild?.roles?.fetch) {
      const roles = await interaction.guild.roles.fetch().catch(() => null);
      staffRole = roles?.find(role => role.name.toLowerCase() === 'staff') || null;
    }

    const botMember = interaction.guild?.members?.me || null;
    const canPingStaff = Boolean(
      staffRole
      && (
        staffRole.mentionable
        || channel.permissionsFor?.(botMember)?.has(PermissionFlagsBits.MentionEveryone)
      ),
    );

    const publishedMessage = await channel.send({
      content: canPingStaff ? `<@&${staffRole.id}>` : undefined,
      embeds: [buildPublishedReview(interaction, rating, comment, staffRole)],
      allowedMentions: canPingStaff ? { roles: [staffRole.id] } : { parse: [] },
    }).catch(() => null);

    if (!publishedMessage) {
      await interaction.editReply({
        content: 'The staff review could not be published right now. Please try again.',
      }).catch(() => {});
      return;
    }

    // Discord only notifies a role when the role mention exists in normal message content.
    // Keep that real ping briefly, then hide it; the embed itself keeps the clickable role
    // mention plus the visual star rating on the same line.
    if (canPingStaff) {
      const hidePingTimer = setTimeout(() => {
        void publishedMessage.edit({ content: null, allowedMentions: { parse: [] } }).catch(() => {});
      }, STAFF_PING_VISIBLE_MS);
      hidePingTimer.unref?.();
    }

    await interaction.editReply({
      content: canPingStaff
        ? 'Your staff review has been published. Thank you!'
        : 'Your staff review has been published. Staff could not be pinged because the bot cannot mention that role.',
    }).catch(() => {});

    const timer = setTimeout(async () => {
      if (interaction.replied || interaction.deferred) {
        await interaction.deleteReply().catch(() => {});
      }
    }, REVIEW_CONFIRMATION_TTL_MS);

    timer.unref?.();
  },
};
