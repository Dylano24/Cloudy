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
export const STAFF_REVIEW_STAR_EMOJI_NAME = 'cloudy_review_star_glow_v1';
const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const OWNER_ROLE_NAME = 'owner';
const PENDING_REVIEW_TTL_MS = 15 * 60 * 1000;
const STAFF_REVIEW_STAR_GIF_BASE64 = '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';

const pendingReviews = new Map();
const reviewStarEmojiCache = new Map();

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
  if (!guild?.emojis) return null;

  const cachedEmojiId = reviewStarEmojiCache.get(guild.id);
  if (cachedEmojiId) {
    const cachedEmoji = guild.emojis.cache.get(cachedEmojiId);
    if (cachedEmoji) return cachedEmoji.toString();
  }

  let emoji = guild.emojis.cache.find(entry => entry.name === STAFF_REVIEW_STAR_EMOJI_NAME) || null;

  if (!emoji && guild.emojis.fetch) {
    const emojis = await guild.emojis.fetch().catch(() => null);
    emoji = emojis?.find(entry => entry.name === STAFF_REVIEW_STAR_EMOJI_NAME) || null;
  }

  if (!emoji) {
    emoji = await guild.emojis.create({
      attachment: Buffer.from(STAFF_REVIEW_STAR_GIF_BASE64, 'base64'),
      name: STAFF_REVIEW_STAR_EMOJI_NAME,
      reason: 'Cloudy staff review rating star',
    }).catch(() => null);
  }

  if (!emoji) return null;

  reviewStarEmojiCache.set(guild.id, emoji.id);
  return emoji.toString();
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
