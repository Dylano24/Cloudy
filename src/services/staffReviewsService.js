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
export const STAFF_REVIEW_STAR_EMOJI_NAME = 'cloudy_review_star_v2';
const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const OWNER_ROLE_NAME = 'owner';
const PENDING_REVIEW_TTL_MS = 15 * 60 * 1000;
const STAFF_REVIEW_STAR_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAACsElEQVR42u3cQVLjQBBE0ZaiI+YIczMfkpvNEVh5FgMsCPAYu9Wq6np/xQ5LmZVZDZJbAwAAAAAAAAAAWJjrS7tWvv6dBWqzl5/+379Kp4AEkAC1p7+11iqngASQAMWnnwFQuQYYQAKI/8opIAEkgOlnAJStgd30SwAUTgEGkADinwFQtgZ20y8BwACoWgNLG0D8SwApUNUApl8CoKoBhk//wjUgASQAKqfAcgaw/EkAVDXA4dO/YA1IAAlg+iunwJZG3DvFmcKf1//f2EuOe7uFEC6KsJNNcpdABxtpO1Rcx7FpRnrUKNvTE07k0w3yTEo8tQRul7aNijrMF3/YDvBRB9Jgai2M2A+GLhgqIcfUH/Z3AJWQS/zhBmCCXOIfYgAmyCP+YQZgghziD18CnRBibvqnGsAJId7UT6kAlRBf/KkGYIJ44k83ABPEEv8UAzBBHPGnLoFOCOdt+mENUPqEcOLUn14B5SshiPhhDFDKBIHED2WAEiYIJn44AyxtgoDih1kClz4hBNj0UxpgiRNC0KkPXQHLVEIC8VMYIKUJkoifxgAoboB0e0CiF0glgAQAA4AB9H/NPUACSAAwABhA/9fcAySABAADgAH0f809QAJIgOIUf0NpLy38+4Mbbz9XJORTK4f2/42HNI/+vRGfEurVpv6WCNulbdeX11LvK/Yqwn839V+Z4F8a1DBCrz71dxlhYROE66RhPTzwhYxhL6kE3AP6ihM/SvgKadBXE//Q79RbcEnspv6JNFjACKH66Mf9H+DFy0c+c6Q9oGee+gg3Mnst9IzCnz31Ky2JnfC10yDMzbzZpYnets12PXv4qU8o/kdSJfgvY48sfkbhsx0Ze8ipby29+FmWxDjfFPrpZq1KpWt96Ka4ZgAAAAAAAAAAAAAAAAAAAOCH/AV7Vm384l31bgAAAABJRU5ErkJggg==';

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
      attachment: Buffer.from(STAFF_REVIEW_STAR_PNG_BASE64, 'base64'),
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
    : '★'.repeat(normalizedRating);
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
