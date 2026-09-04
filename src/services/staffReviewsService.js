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
export const STAFF_REVIEW_STAR_EMOJI_NAME = 'W84starwhite_pulse_v3';
export const STAFF_REVIEW_STAR_EMOJI_ID = '1543289625035022346';
const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const OWNER_ROLE_NAME = 'owner';
const PENDING_REVIEW_TTL_MS = 15 * 60 * 1000;
const STAFF_REVIEW_STAR_GIF_BASE64 = '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';

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
  if (!guild?.emojis) return null;

  let emoji = guild.emojis.cache.find(entry => entry.name === STAFF_REVIEW_STAR_EMOJI_NAME) || null;
  if (!emoji && guild.emojis.fetch) {
    const emojis = await guild.emojis.fetch().catch(() => null);
    emoji = emojis?.find?.(entry => entry.name === STAFF_REVIEW_STAR_EMOJI_NAME) || null;
  }

  if (!emoji) {
    emoji = await guild.emojis.create({
      attachment: Buffer.from(STAFF_REVIEW_STAR_GIF_BASE64, 'base64'),
      name: STAFF_REVIEW_STAR_EMOJI_NAME,
      reason: 'Animated pulse for the existing W84starwhite review star',
    }).catch(() => null);
  }

  if (emoji) return emoji.toString();

  const staticEmoji = guild.emojis.cache.get(STAFF_REVIEW_STAR_EMOJI_ID)
    || (guild.emojis.fetch
      ? await guild.emojis.fetch(STAFF_REVIEW_STAR_EMOJI_ID).catch(() => null)
      : null);
  return staticEmoji?.toString?.() || null;
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
