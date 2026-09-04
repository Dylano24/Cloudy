import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export const STAFF_REVIEWS_CHANNEL_ID = '1533965979682476082';
export const COMMUNITY_REVIEWS_CHANNEL_ID = '1540625438601379961';
export const STAFF_REVIEW_MEMBER_ID = 'staff_review_member';
export const STAFF_REVIEW_RATING_ID = 'staff_review_rating';
export const STAFF_REVIEW_MODAL_ID = 'staff_review_modal';
export const STAFF_REVIEW_LOGO_NAME = 'cloudy-c-logo.png';
export const STAFF_REVIEW_LOGO_PATH = join(MODULE_DIR, '../../assets/cloudy-c-logo.png');
export const STAFF_REVIEW_STAR_EMOJI_NAME = 'W84staryellow_v1';
export const STAFF_REVIEW_STAR_EMOJI_ID = '1543289625035022346';
const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const OWNER_ROLE_NAME = 'owner';
const PENDING_REVIEW_TTL_MS = 15 * 60 * 1000;
const STAFF_REVIEW_STAR_PNG_BASE64 = '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';

const pendingReviews = new Map();

function reviewContextKey(userId, reviewId) {
  return `${userId}:${reviewId}`;
}

function pruneExpiredReviews() {
  const now = Date.now();
  for (const [key, entry] of pendingReviews) {
    if (now - entry.updatedAt > PENDING_REVIEW_TTL_MS) {
      pendingReviews.delete(key);
    }
  }
}

function buildRatingMenu(disabled = false, memberId = '') {
  return new StringSelectMenuBuilder()
    .setCustomId(memberId ? `${STAFF_REVIEW_RATING_ID}:${memberId}` : STAFF_REVIEW_RATING_ID)
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
      'We want to hear about your experience with our staff team!\n\n'
      + 'Share your feedback by selecting the staff member you would like to review, giving them a rating, and then writing a comment describing your experience.\n\n'
      + 'Please keep your feedback respectful and constructive. Any inappropriate, offensive, insulting, or irrelevant submissions may be removed.\n\n'
      + `Once submitted, your review will be published in the [posted reviews](https://discord.com/channels/@me/${COMMUNITY_REVIEWS_CHANNEL_ID}) section.\n\n`
      + 'Your reviews not only help us improve, but also encourage and support our staff team. We truly appreciate you taking the time to share your experience and show your support!',
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
    components: [new ActionRowBuilder().addComponents(buildRatingMenu(false, memberId))],
    allowedMentions: { parse: [] },
  };
}

export function createReviewContext(userId, memberId, rating) {
  pruneExpiredReviews();
  const reviewId = randomUUID();
  pendingReviews.set(reviewContextKey(userId, reviewId), {
    memberId,
    rating: Number(rating),
    updatedAt: Date.now(),
  });
  return reviewId;
}

export function takeReviewContext(userId, reviewId) {
  pruneExpiredReviews();
  const key = reviewContextKey(userId, reviewId);
  const context = pendingReviews.get(key) || null;
  pendingReviews.delete(key);
  return context;
}

export function buildStaffReviewModal(memberOrReviewId, rating = null) {
  const normalizedRating = Number(rating);
  const hasEmbeddedContext = /^\d{16,22}$/.test(String(memberOrReviewId || ''))
    && Number.isInteger(normalizedRating)
    && normalizedRating >= 1
    && normalizedRating <= 5;

  const customId = hasEmbeddedContext
    ? `${STAFF_REVIEW_MODAL_ID}:${memberOrReviewId}:${normalizedRating}`
    : `${STAFF_REVIEW_MODAL_ID}:${memberOrReviewId}`;

  const comment = new TextInputBuilder()
    .setCustomId('staff_review_comment')
    .setLabel('Tell us about your experience')
    .setPlaceholder('Write your review here...')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(3)
    .setMaxLength(1000)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(customId)
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
  if (!ownerRole || !guild.members?.fetch) return false;

  const member = await guild.members.fetch({ user: memberId, force: true }).catch(() => null);
  return Boolean(member && !member.user?.bot && member.roles?.cache?.has(ownerRole.id));
}

export async function ensureStaffReviewStarEmoji(guild) {
  if (!guild) return null;

  const emojiManagers = [guild.client?.application?.emojis, guild.emojis].filter(Boolean);
  for (const emojiManager of emojiManagers) {
    let emoji = emojiManager.cache?.find?.(
      entry => entry.name === STAFF_REVIEW_STAR_EMOJI_NAME,
    ) || null;

    if (!emoji && emojiManager.fetch) {
      const emojis = await emojiManager.fetch().catch(() => null);
      emoji = emojis?.find?.(entry => entry.name === STAFF_REVIEW_STAR_EMOJI_NAME) || null;
    }

    if (!emoji && emojiManager.create) {
      emoji = await emojiManager.create({
        attachment: Buffer.from(STAFF_REVIEW_STAR_PNG_BASE64, 'base64'),
        name: STAFF_REVIEW_STAR_EMOJI_NAME,
        reason: 'Yellow version of the W84starwhite review star',
      }).catch(() => null);
    }

    if (emoji) return emoji.toString();
  }

  return null;
}

export function buildPublishedReview(interaction, rating, comment, memberId, starEmoji = null) {
  const normalizedRating = Math.max(1, Math.min(5, Number(rating) || 1));
  const stars = starEmoji
    ? Array.from({ length: normalizedRating }, () => starEmoji).join('')
    : '⭐'.repeat(normalizedRating);
  const randomSideColor = Math.floor(Math.random() * 0x1000000);

  return new EmbedBuilder()
    .setColor(randomSideColor)
    .setAuthor({
      name: interaction.user.globalName || interaction.user.username,
      iconURL: interaction.user.displayAvatarURL(),
    })
    .setThumbnail(CLOUDY_C_LOGO_URL)
    .setDescription(
      `**Staff member**\n<@${memberId}>\n\n`
      + `**Rating**\n${stars}\n\n`
      + `**Experience**\n${comment}`,
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}
