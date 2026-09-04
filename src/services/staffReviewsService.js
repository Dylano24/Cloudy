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
export const STAFF_REVIEW_STAR_EMOJI_NAME = 'W84starwhite_pulse_v2';
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
