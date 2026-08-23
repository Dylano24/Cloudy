import {
  ActionRowBuilder,
  Events,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js';
import {
  COMMUNITY_REVIEWS_CHANNEL_ID,
  STAFF_REVIEW_LOGO_NAME,
  STAFF_REVIEW_LOGO_PATH,
  STAFF_REVIEW_MEMBER_ID,
  STAFF_REVIEW_MODAL_ID,
  STAFF_REVIEW_RATING_ID,
  buildPublishedReview,
  buildStaffReviewModal,
  createReviewContext,
  isOwnerReviewTarget,
  takeReviewContext,
} from '../services/staffReviewsService.js';

const REVIEW_CONFIRMATION_TTL_MS = 10 * 1000;
const OWNER_SELECTION_TTL_MS = 15 * 60 * 1000;
const selectedOwners = new Map();

function selectionKey(interaction) {
  return `${interaction.guildId || 'dm'}:${interaction.user.id}`;
}

function rememberSelectedOwner(interaction, memberId) {
  selectedOwners.set(selectionKey(interaction), {
    memberId,
    updatedAt: Date.now(),
  });
}

function getSelectedOwner(interaction) {
  const key = selectionKey(interaction);
  const selected = selectedOwners.get(key);
  if (!selected) return null;

  if (Date.now() - selected.updatedAt > OWNER_SELECTION_TTL_MS) {
    selectedOwners.delete(key);
    return null;
  }

  return selected.memberId;
}

function clearSelectedOwner(interaction) {
  selectedOwners.delete(selectionKey(interaction));
}

function buildSelectedOwnerRow(interaction, memberId) {
  const existingMemberMenu = interaction.message?.components?.[0]?.components?.[0];
  if (!existingMemberMenu) return null;

  const memberMenu = StringSelectMenuBuilder.from(existingMemberMenu);
  for (const option of memberMenu.options) {
    option.setDefault(option.data?.value === memberId);
  }

  return new ActionRowBuilder().addComponents(memberMenu);
}

function buildEnabledRatingRow(interaction) {
  const existingRating = interaction.message?.components?.[1]?.components?.[0];
  if (!existingRating) return null;

  const ratingMenu = StringSelectMenuBuilder.from(existingRating)
    .setCustomId(STAFF_REVIEW_RATING_ID)
    .setDisabled(false);

  return new ActionRowBuilder().addComponents(ratingMenu);
}

export default {
  name: Events.InteractionCreate,
  once: false,

  /**
   * Enforce the staff-review flow: Owner member -> rating -> written review.
   * The selected Owner is kept per reviewer so multiple members can use the
   * public panel without sharing each other's review target.
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

      rememberSelectedOwner(interaction, memberId);

      const selectedOwnerRow = buildSelectedOwnerRow(interaction, memberId);
      const enabledRatingRow = buildEnabledRatingRow(interaction);
      if (!selectedOwnerRow || !enabledRatingRow) {
        await interaction.reply({
          content: 'The review selectors could not be updated. Please try again.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      await interaction.update({
        components: [selectedOwnerRow, enabledRatingRow],
      }).catch(() => {});
      return;
    }

    if (interaction.isStringSelectMenu?.() && interaction.customId === STAFF_REVIEW_RATING_ID) {
      const memberId = getSelectedOwner(interaction);
      if (!memberId) {
        await interaction.reply({
          content: 'Choose one of the Owners first, then select your rating.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      const validTarget = await isOwnerReviewTarget(interaction.guild, memberId);
      if (!validTarget) {
        clearSelectedOwner(interaction);
        await interaction.reply({
          content: 'That member is no longer available for staff reviews. Please choose another member.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      const rating = Number(interaction.values?.[0]);
      if (!rating || rating < 1 || rating > 5) return;

      const reviewId = createReviewContext(interaction.user.id, memberId, rating);
      clearSelectedOwner(interaction);
      await interaction.showModal(buildStaffReviewModal(reviewId));
      return;
    }

    const modalPrefix = `${STAFF_REVIEW_MODAL_ID}:`;
    if (!interaction.isModalSubmit?.() || !interaction.customId.startsWith(modalPrefix)) return;

    const reviewId = interaction.customId.slice(modalPrefix.length);
    if (!reviewId) return;

    const reviewContext = takeReviewContext(interaction.user.id, reviewId);
    if (!reviewContext?.memberId || !reviewContext?.rating) {
      await interaction.reply({
        content: 'This review session expired. Please choose the staff member and star rating again.',
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
