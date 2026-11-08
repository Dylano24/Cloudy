import {
  ActionRowBuilder, EmbedBuilder, ModalBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { nextReviewSideColor } from './staffReviewsService.js';

export const SERVICE_REVIEWS_CHANNEL_ID = '1568553373286801450';
export const SERVICE_POSTED_REVIEWS_CHANNEL_ID = '1568553442870558720';
export const SERVICE_REVIEW_SELECT_ID = 'service_review_service';
export const SERVICE_REVIEW_RATING_ID = 'service_review_rating';
export const SERVICE_REVIEW_MODAL_ID = 'service_review_modal';
export const SERVICE_REVIEW_PANEL_TITLE = 'Product & service reviews';
export const SERVICE_REVIEW_PANEL_MESSAGE_ID = '1568560974548697170';

// These are exactly the offerings described in the owner-written panel.
// Keep that panel's description, footer and logo untouched.
export const SERVICE_REVIEW_TYPES = Object.freeze({
  bot: 'Cloudy bot',
  website: 'Website',
  servers: 'Game servers',
  store: 'Game store',
  services: 'Services',
});

const LOGO = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

export function serviceReviewChoiceRow(selectedType = null) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(SERVICE_REVIEW_SELECT_ID)
      .setPlaceholder('Choose a product or service')
      .addOptions(Object.entries(SERVICE_REVIEW_TYPES)
        .map(([value, label]) => ({ label, value, default: value === selectedType }))),
  );
}

export function serviceReviewRatingRow(type = null) {
  if (type !== null && !Object.hasOwn(SERVICE_REVIEW_TYPES, type)) throw new RangeError('Invalid product or service');
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(SERVICE_REVIEW_RATING_ID)
      .setPlaceholder('Choose your rating')
      .setDisabled(type === null)
      .addOptions([1, 2, 3, 4, 5].map(rating => ({
        label: '★'.repeat(rating),
        value: String(rating),
      }))),
  );
}

// Match Staff Reviews: one public panel with a disabled rating until a service is chosen.
// Never post a separate ephemeral rating dropdown.
export function serviceReviewPanelRows(type = null) {
  return [serviceReviewChoiceRow(type), serviceReviewRatingRow(type)];
}

export function serviceReviewModal(type, rating) {
  if (!Object.hasOwn(SERVICE_REVIEW_TYPES, type) || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new RangeError('Invalid review details');
  }
  return new ModalBuilder()
    .setCustomId(`${SERVICE_REVIEW_MODAL_ID}:${type}:${rating}`)
    .setTitle('Product & service review')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('service_review_comment')
        .setLabel('Tell us about your experience')
        .setPlaceholder('Write your review here...')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(3)
        .setMaxLength(1000)
        .setRequired(true),
    ));
}

export function buildPublishedServiceReview(interaction, type, rating, comment, emoji = null) {
  if (!Object.hasOwn(SERVICE_REVIEW_TYPES, type)) throw new RangeError('Invalid service');
  const stars = emoji ? emoji.repeat(rating) : '⭐'.repeat(rating);
  // Cloudy's shared embeds helper globally removes Unicode emoji, ordinary
  // footers and timestamps from fluent EmbedBuilder setters. The owner asked
  // for the SAME stars, footer and authored look as Staff Reviews; supply the
  // trusted, validated embed fields as raw data to preserve them.
  return new EmbedBuilder({
    color: nextReviewSideColor(),
    author: {
      name: interaction.user.globalName || interaction.user.username,
      icon_url: interaction.user.displayAvatarURL(),
    },
    thumbnail: { url: LOGO },
    description: `**Product or service**\n${SERVICE_REVIEW_TYPES[type]}\n\n`
      + `**Rating**\n${stars}\n\n`
      + `**Experience**\n${comment}`,
    footer: { text: FOOTER },
    timestamp: new Date().toISOString(),
  });
}
