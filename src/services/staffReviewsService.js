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
export const STAFF_REVIEW_STAR_EMOJI_NAME = 'cloudy_review_star';
const CLOUDY_C_LOGO_URL = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo.png';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const OWNER_ROLE_NAME = 'owner';
const PENDING_REVIEW_TTL_MS = 15 * 60 * 1000;
const STAFF_REVIEW_STAR_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAADZklEQVR42u2dQW6rQBBEB4SUG2SfY/g2OZpvk2N4nxuwIps4cWwzsaEHqrvfkyJF+hvsrq4q+EBKAQAAAAAAAAAAAAAACMx0LFPmz98jgdz06bf/7SW1C+AAOEDu7UcAUDLHAALAAbB/BABpYwAB4ADJ7f/1kNoFcAAcgO3/4wIIgDKYKQbyCiDx1qcUwL/n/kkFQQQkj4GcApjb9oQukEIAXPrFAZ7f8iQx0LP9uWOAEkgEYP+ZYyC0ABaXv0Qx0LP9RADbXxNM8Bjo2X4cABKXwZACMLvyl8A54jsA9k8EEAOJBPDH/i22P7iD4ABEAOUv8zWBQWZwjsqf1fF276VzKwDToXm6WcPwWKfjaPYdLhVTt3oTFIfXavs/P/Q+62lc5ST9atWdxlJOI21qh8GvHf5qB2juBlFOwaydw2Dw5gKYFQFX4mzFYzh889PAn0hQz02G38YBbs4Q5h7DhueG/71ULU4bm56HEgmaW98sAogEX8NvLgBEoD385hFAL9DK+10FQC/Q2fpNI4BI0B3+Lg5AJOxr+TICmI2E6CK4Gv7e/yW8+w0hN5EQOQ7Ehi/hACnKoUjeSwsgbC8Qynt5AYTrBYKWL9cBwvYCB8OXdQDXvUA4790JwF0vEM97lwJw0wucWL6LDvBQL1DF0fBdCQCSI8D8oU9rnD4+hgPgAIAAAAGQ/zl7AA6AAwACAHucxIC8ANzk/3UPwAEAAQACMLP/Fnx+/P4k7QF+HMA6W6+HbikCRz1gKNmoDfr8b/zFkKCDvzf8e/cYJHpUTVYApvk/N/jzzRv33nRm1Q3Ee4CPCFhqyXMDvLpr5/z7dBxvRbc0Fl4PLpwkZgTU7L5yy1b1vYdBYyHegyEPbv2qCHr0eHgwRH/rZzcjiRvod4D/tq2y8Zf5vsge13YDBz1gcL/1Bnb/iBB+3uxtVRLpACvyv+HWm3cD8R4whNj4Db/caG6gXQIvv8ja1m+8Wd176apPKl0eq7gYBrZ+Qzd4eynTcZx4QcSSfN0461seu9Jx+zsLEL2gUnUDIsBm8Gpb/9R1A04DF1qokxct3P08c24g5GKD+tZ7G7w3N+hVB+95+DdCEP7LagNbn9sNJL7oyztmog0/82dd9KXwmQEAAAAAAAAAAAAAAAAAAAAAAAAAAJ7kC4il+uSTtzJoAAAAAElFTkSuQmCC';

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
    .setThumbnail(CLOUDY_C_LOGO_URL)
    .setDescription(
      `**Staff review**\n<@${memberId}>\n\n${stars}\n\n`
      + `**Review**\n${comment}`,
    )
    .setFooter({ text: FOOTER })
    .setTimestamp();
}
