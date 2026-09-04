import {
  ActionRowBuilder,
  Events,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js';
import {
  COMMUNITY_REVIEWS_CHANNEL_ID,
  STAFF_REVIEW_MEMBER_ID,
  STAFF_REVIEW_MODAL_ID,
  STAFF_REVIEW_RATING_ID,
  buildPublishedReview,
  buildStaffReviewModal,
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

  const data = typeof existingMemberMenu.toJSON === 'function'
    ? existingMemberMenu.toJSON()
    : existingMemberMenu;

  const memberMenu = new StringSelectMenuBuilder({
    ...data,
    options: (data.options || []).map(option => ({
      ...option,
      default: option.value === memberId,
    })),
  });

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

function resolveModalContext(interaction) {
  const modalPrefix = `${STAFF_REVIEW_MODAL_ID}:`;
  if (!interaction.customId.startsWith(modalPrefix)) return null;

  const parts = interaction.customId.slice(modalPrefix.length).split(':');
  const memberId = parts[0];
  const rating = Number(parts[1]);

  if (/^\d{16,22}$/.test(memberId || '') && Number.isInteger(rating) && rating >= 1 && rating <= 5) {
    return { memberId, rating };
  }

  const legacyReviewId = parts[0];
  if (!legacyReviewId) return null;
  return takeReviewContext(interaction.user.id, legacyReviewId);
}

export default {
  name: Events.InteractionCreate,
  once: false,

  async execute(interaction) {
    if (interaction.isStringSelectMenu?.() && interaction.customId === STAFF_REVIEW_MEMBER_ID) {
      const memberId = interaction.values?.[0];
      if (!memberId || memberId === 'none') return;

      try {
        await interaction.deferUpdate();
      } catch {
        return;
      }

      rememberSelectedOwner(interaction, memberId);

      const selectedOwnerRow = buildSelectedOwnerRow(interaction, memberId);
      const enabledRatingRow = buildEnabledRatingRow(interaction);
      if (!selectedOwnerRow || !enabledRatingRow) {
        await interaction.followUp({
          content: 'The review selectors could not be updated. Please try again.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      await interaction.editReply({
        components: [selectedOwnerRow, enabledRatingRow],
      }).catch(() => {});
      return;
    }

    const ratingPrefix = `${STAFF_REVIEW_RATING_ID}:`;
    if (
      interaction.isStringSelectMenu?.()
      && (interaction.customId === STAFF_REVIEW_RATING_ID || interaction.customId.startsWith(ratingPrefix))
    ) {
      const embeddedMemberId = interaction.customId.startsWith(ratingPrefix)
        ? interaction.customId.slice(ratingPrefix.length)
        : null;
      const memberId = embeddedMemberId || getSelectedOwner(interaction);
      if (!memberId) {
        await interaction.reply({
          content: 'Choose one of the Owners first, then select your rating.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      const rating = Number(interaction.values?.[0]);
      if (!rating || rating < 1 || rating > 5) return;

      const validTarget = await isOwnerReviewTarget(interaction.guild, memberId);
      if (!validTarget) {
        clearSelectedOwner(interaction);
        await interaction.reply({
          content: 'That member is no longer available for staff reviews. Please start again.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      clearSelectedOwner(interaction);

      try {
        await interaction.showModal(buildStaffReviewModal(memberId, rating));
      } catch {
        return;
      }
      return;
    }

    const modalPrefix = `${STAFF_REVIEW_MODAL_ID}:`;
    if (!interaction.isModalSubmit?.() || !interaction.customId.startsWith(modalPrefix)) return;

    const reviewContext = resolveModalContext(interaction);
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
      allowedMentions: { parse: [] },
    }).catch(() => null);

    if (!publishedMessage) {
      await interaction.editReply({
        content: 'The staff review could not be published right now. Please try again.',
      }).catch(() => {});
      return;
    }

    if (publishedMessage.attachments?.size) {
      await publishedMessage.edit({ attachments: [] }).catch(() => {});
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
