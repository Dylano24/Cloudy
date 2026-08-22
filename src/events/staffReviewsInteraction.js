import { EmbedBuilder, Events, MessageFlags } from 'discord.js';
import {
  STAFF_REVIEWS_CHANNEL_ID,
  STAFF_REVIEWS_PAGE_PREFIX,
  STAFF_REVIEWS_VIEW_ID,
  STAFF_REVIEW_MODAL_ID,
  STAFF_REVIEW_RATING_ID,
  buildPublishedReview,
  buildReviewsPagination,
  buildStaffReviewModal,
  rememberRating,
  takeRating,
} from '../services/staffReviewsService.js';

const REVIEW_CONFIRMATION_TTL_MS = 10 * 1000;
const REVIEWS_PER_PAGE = 5;

async function fetchPublishedReviews(channel, botUserId) {
  const reviews = [];
  let before;

  for (let batch = 0; batch < 10; batch += 1) {
    const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!messages?.size) break;

    for (const message of messages.values()) {
      if (message.author?.id !== botUserId) continue;
      const embed = message.embeds?.[0];
      if (!embed?.title?.endsWith('Staff review')) continue;
      reviews.push(message);
    }

    before = messages.last()?.id;
    if (messages.size < 100 || !before) break;
  }

  return reviews.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
}

async function buildReviewsView(interaction, requestedPage = 0) {
  const channel = await interaction.client.channels.fetch(STAFF_REVIEWS_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased?.()) {
    return { content: 'The staff reviews channel is currently unavailable.', embeds: [], components: [] };
  }

  const reviews = await fetchPublishedReviews(channel, interaction.client.user.id);
  if (!reviews.length) {
    return { content: 'There are no staff reviews yet.', embeds: [], components: [] };
  }

  const totalPages = Math.ceil(reviews.length / REVIEWS_PER_PAGE);
  const page = Math.max(0, Math.min(totalPages - 1, Number(requestedPage) || 0));
  const start = page * REVIEWS_PER_PAGE;
  const embeds = reviews
    .slice(start, start + REVIEWS_PER_PAGE)
    .map(message => EmbedBuilder.from(message.embeds[0]));

  return {
    content: `Staff reviews • Page ${page + 1}/${totalPages} • ${reviews.length} total`,
    embeds,
    components: buildReviewsPagination(page, totalPages),
  };
}

export default {
  name: Events.InteractionCreate,
  once: false,

  async execute(interaction) {
    if (interaction.isButton?.() && interaction.customId === STAFF_REVIEWS_VIEW_ID) {
      const payload = await buildReviewsView(interaction, 0);
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    if (interaction.isButton?.() && interaction.customId?.startsWith(STAFF_REVIEWS_PAGE_PREFIX)) {
      const page = Number(interaction.customId.slice(STAFF_REVIEWS_PAGE_PREFIX.length));
      const payload = await buildReviewsView(interaction, page);
      await interaction.update(payload).catch(() => {});
      return;
    }

    if (interaction.isStringSelectMenu?.() && interaction.customId === STAFF_REVIEW_RATING_ID) {
      const rating = Number(interaction.values?.[0]);
      if (!rating || rating < 1 || rating > 5) return;

      rememberRating(interaction.user.id, rating);
      await interaction.showModal(buildStaffReviewModal());
      return;
    }

    if (!interaction.isModalSubmit?.() || interaction.customId !== STAFF_REVIEW_MODAL_ID) return;

    const rating = takeRating(interaction.user.id);
    if (!rating) {
      await interaction.reply({
        content: 'Please choose your star rating again before submitting a review.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    const comment = interaction.fields.getTextInputValue('staff_review_comment')?.trim();
    if (!comment) return;

    const channel = await interaction.client.channels.fetch(STAFF_REVIEWS_CHANNEL_ID).catch(() => null);
    if (!channel?.isSendable?.()) {
      await interaction.reply({
        content: 'The staff reviews channel is currently unavailable.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    await channel.send({ embeds: [buildPublishedReview(interaction, rating, comment)] });
    await interaction.reply({
      content: 'Your staff review has been published. Thank you!',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});

    const timer = setTimeout(async () => {
      if (interaction.replied || interaction.deferred) {
        await interaction.deleteReply().catch(() => {});
      }
    }, REVIEW_CONFIRMATION_TTL_MS);

    timer.unref?.();
  },
};
