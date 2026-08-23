import {
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

export const STAFF_REVIEWS_CHANNEL_ID = '1533965979682476082';
export const COMMUNITY_REVIEWS_CHANNEL_ID = '1540625438601379961';
export const STAFF_REVIEW_RATING_ID = 'staff_review_rating';
export const STAFF_REVIEW_MODAL_ID = 'staff_review_modal';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

const pendingRatings = new Map();

export function buildStaffReviewsPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setTitle('Staff reviews')
    .setDescription(
      'Share your experience with the Cloudy staff team.\n\n'
      + 'Choose a rating below, then leave a short comment about your experience.\n\n'
      + `Your review will be published in <#${COMMUNITY_REVIEWS_CHANNEL_ID}> for everyone to see.`,
    )
    .setFooter({ text: FOOTER });

  const ratingMenu = new StringSelectMenuBuilder()
    .setCustomId(STAFF_REVIEW_RATING_ID)
    .setPlaceholder('Choose your rating')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('⭐').setValue('1'),
      new StringSelectMenuOptionBuilder().setLabel('⭐⭐').setValue('2'),
      new StringSelectMenuOptionBuilder().setLabel('⭐⭐⭐').setValue('3'),
      new StringSelectMenuOptionBuilder().setLabel('⭐⭐⭐⭐').setValue('4'),
      new StringSelectMenuOptionBuilder().setLabel('⭐⭐⭐⭐⭐').setValue('5'),
    );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(ratingMenu)],
  };
}

export function rememberRating(userId, rating) {
  pendingRatings.set(userId, Number(rating));
}

export function takeRating(userId) {
  const rating = pendingRatings.get(userId) || null;
  pendingRatings.delete(userId);
  return rating;
}

export function buildStaffReviewModal() {
  const comment = new TextInputBuilder()
    .setCustomId('staff_review_comment')
    .setLabel('Tell us about your experience')
    .setPlaceholder('Write your review here...')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(3)
    .setMaxLength(1000)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(STAFF_REVIEW_MODAL_ID)
    .setTitle('Staff review')
    .addComponents(new ActionRowBuilder().addComponents(comment));
}

/**
 * Build the published community review embed with a stable visible Staff label
 * and the exact number of stars selected by the reviewer.
 */
export function buildPublishedReview(interaction, rating, comment, staffRole = null) {
  const normalizedRating = Math.max(1, Math.min(5, Number(rating) || 1));
  const stars = '⭐'.repeat(normalizedRating);
  // Keep the real role ping in normal message content (handled by the interaction event),
  // but render a stable visual label in the embed so Discord mobile cannot swallow the stars.
  const staffLabel = `@${staffRole?.name || 'Staff'}`;
  const ratingColors = {
    1: 0xED4245,
    2: 0xFF7A00,
    3: 0xF1C40F,
    4: 0x3498DB,
    5: 0x57F287,
  };

  return new EmbedBuilder()
    .setColor(ratingColors[normalizedRating])
    .setAuthor({
      name: interaction.user.globalName || interaction.user.username,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setDescription(`${staffLabel} ${stars}\n\n${comment}`)
    .addFields({ name: 'Rating', value: `${normalizedRating}/5`, inline: false })
    .setFooter({ text: FOOTER })
    .setTimestamp();
}
