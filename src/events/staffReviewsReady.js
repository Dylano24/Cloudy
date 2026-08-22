import { EmbedBuilder, Events } from 'discord.js';
import {
  COMMUNITY_REVIEWS_CHANNEL_ID,
  STAFF_REVIEWS_CHANNEL_ID,
  STAFF_REVIEW_RATING_ID,
  buildStaffReviewsPanel,
} from '../services/staffReviewsService.js';

const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

async function reformatExistingReviews(client) {
  const channel = await client.channels.fetch(COMMUNITY_REVIEWS_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  let before;
  for (let batch = 0; batch < 10; batch += 1) {
    const messages = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    }).catch(() => null);

    if (!messages?.size) break;

    for (const message of messages.values()) {
      if (message.author?.id !== client.user?.id) continue;
      const source = message.embeds?.[0];
      if (!source?.title?.endsWith('Staff review')) continue;

      const ratingField = source.fields?.find(field => field.name === 'Rating');
      if (!ratingField) continue;

      let description = source.description || '';
      description = description
        .replace(`\n\n**${FOOTER}**`, '')
        .replace(`\n\n${FOOTER}`, '')
        .trim();

      const updated = EmbedBuilder.from(source)
        .setDescription(description)
        .setFields({
          name: 'Rating',
          value: ratingField.value,
          inline: false,
        })
        .setFooter({ text: FOOTER });

      await message.edit({ embeds: [updated] }).catch(() => {});
    }

    before = messages.last()?.id;
    if (messages.size < 100 || !before) break;
  }
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      const channel = await client.channels.fetch(STAFF_REVIEWS_CHANNEL_ID).catch(() => null);
      if (channel?.isSendable?.()) {
        const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
        const existing = recent?.find(message =>
          message.author?.id === client.user?.id
          && message.components?.some(row => row.components?.some(component => component.customId === STAFF_REVIEW_RATING_ID)),
        );

        const payload = buildStaffReviewsPanel();
        if (existing) {
          await existing.edit(payload).catch(() => {});
        } else {
          await channel.send(payload).catch(() => {});
        }
      }

      await reformatExistingReviews(client);
    }, 2500);

    timer.unref?.();
  },
};
