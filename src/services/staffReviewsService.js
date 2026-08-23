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
export const STAFF_REVIEW_MEMBER_ID = 'staff_review_member';
export const STAFF_REVIEW_RATING_ID = 'staff_review_rating';
export const STAFF_REVIEW_MODAL_ID = 'staff_review_modal';
export const STAFF_REVIEW_LOGO_NAME = 'cloudy-c-logo.png';
export const STAFF_REVIEW_LOGO_PATH = 'assets/cloudy-c-logo.png';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const OWNER_ROLE_NAME = 'owner';

const pendingReviews = new Map();

function buildRatingMenu(disabled = false) {
  return new StringSelectMenuBuilder()
    .setCustomId(STAFF_REVIEW_RATING_ID)
    .setPlaceholder('Choose your rating')
    .setDisabled(disabled)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('⭐').setValue('1'),
      new StringSelectMenuOptionBuilder().setLabel('⭐⭐').setValue('2'),
      new StringSelectMenuOptionBuilder().setLabel('⭐⭐⭐').setValue('3'),
      new StringSelectMenuOptionBuilder().setLabel('⭐⭐⭐⭐').setValue('4'),
      new StringSelectMenuOptionBuilder().setLabel('⭐⭐⭐⭐⭐').setValue('5'),
    );
}

function buildMemberMenu(ownerMembers = []) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(STAFF_REVIEW_MEMBER_ID)
    .setPlaceholder('Choose the staff member');

  if (!ownerMembers.length) {
    return menu
      .setDisabled(true)
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('No Owner members available')
          .setValue('none'),
      );
  }

  menu.addOptions(
    ownerMembers.slice(0, 25).map(member => {
      const username = member.user?.username || member.displayName;
      const option = new StringSelectMenuOptionBuilder()
        .setLabel(member.displayName.slice(0, 100))
        .setValue(member.id);

      if (username) {
        option.setDescription(`@${username}`.slice(0, 100));
      }

      return option;
    }),
  );

  return menu;
}

export function buildStaffReviewsPanel(ownerMembers = []) {
  const embed = new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setTitle('Staff reviews')
    .setDescription(
      'Share your experience with the Cloudy staff team.\n\n'
      + 'First choose the staff member you want to review. Then choose a rating and leave a short comment about your experience.\n\n'
      + `Your review will be published in <#${COMMUNITY_REVIEWS_CHANNEL_ID}> for everyone to see.`,
    )
    .setFooter({ text: FOOTER });

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(buildMemberMenu(ownerMembers)),
      new ActionRowBuilder().addComponents(buildRatingMenu(true)),
    ],
  };
}

export function buildRatingPrompt(memberId) {
  return {
    content: `Now choose your rating for <@${memberId}>.`,
    components: [new ActionRowBuilder().addComponents(buildRatingMenu(false))],
    allowedMentions: { parse: [] },
  };
}

export function rememberReviewMember(userId, memberId) {
  const current = pendingReviews.get(userId) || {};
  pendingReviews.set(userId, { ...current, memberId, rating: null });
}

export function getReviewMember(userId) {
  return pendingReviews.get(userId)?.memberId || null;
}

export function rememberRating(userId, rating) {
  const current = pendingReviews.get(userId) || {};
  pendingReviews.set(userId, { ...current, rating: Number(rating) });
}

export function takeReviewContext(userId) {
  const context = pendingReviews.get(userId) || null;
  pendingReviews.delete(userId);
  return context;
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

async function getOwnerRole(guild) {
  if (!guild) return null;

  let ownerRole = guild.roles?.cache?.find(role => role.name.toLowerCase() === OWNER_ROLE_NAME) || null;
  if (!ownerRole && guild.roles?.fetch) {
    const roles = await guild.roles.fetch().catch(() => null);
    ownerRole = roles?.find(role => role.name.toLowerCase() === OWNER_ROLE_NAME) || null;
  }

  return ownerRole;
}

export async function getOwnerMembers(guild) {
  const ownerRole = await getOwnerRole(guild);
  if (!ownerRole || !guild?.members) return [];

  const members = await guild.members.fetch().catch(() => guild.members.cache);
  if (!members) return [];

  return [...members.values()]
    .filter(member => !member.user?.bot && member.roles?.cache?.has(ownerRole.id))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function isOwnerReviewTarget(guild, memberId) {
  if (!guild || !memberId) return false;

  const ownerRole = await getOwnerRole(guild);
  if (!ownerRole) return false;

  const member = await guild.members?.fetch?.(memberId).catch(() => null)
    || guild.members?.cache?.get(memberId)
    || null;

  return Boolean(member && !member.user?.bot && member.roles?.cache?.has(ownerRole.id));
}

/**
 * Build the published review exactly as displayed in the community channel:
 * Staff review title, reviewed member, yellow stars, written comment, and the
 * existing Cloudy footer. The Cloudy C is attached as the top-right thumbnail.
 */
export function buildPublishedReview(interaction, rating, comment, memberId) {
  const normalizedRating = Math.max(1, Math.min(5, Number(rating) || 1));
  const stars = '⭐'.repeat(normalizedRating);
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
    .setTitle('Staff review')
    .setThumbnail(`attachment://${STAFF_REVIEW_LOGO_NAME}`)
    .setDescription(`<@${memberId}>\n${stars}\n${comment}`)
    .setFooter({ text: FOOTER })
    .setTimestamp();
}
