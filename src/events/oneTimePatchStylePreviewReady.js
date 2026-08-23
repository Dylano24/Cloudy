import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
} from 'discord.js';
import { logger } from '../utils/logger.js';

const PREVIEWS = [
  {
    name: 'Rust',
    channelId: '1533886914459861103',
    markerKey: 'global:preview:rust-patch-style:white-v1',
  },
  {
    name: 'Nitrado',
    channelId: '1539397467647377530',
    markerKey: 'global:preview:nitrado-patch-style:white-v1',
  },
];

async function sendPreviewOnce(client, preview) {
  const alreadySent = await client.db?.get?.(preview.markerKey).catch(() => null);
  if (alreadySent === 'sent') return;

  const channel = await client.channels.fetch(preview.channelId);
  if (!channel?.isTextBased()) {
    throw new Error(`${preview.name} preview channel ${preview.channelId} is not text based`);
  }

  const messages = await channel.messages.fetch({ limit: 100 });
  const sourceMessage = messages.find(message =>
    message.author.id === client.user.id
    && message.embeds.length > 0
    && Boolean(message.embeds[0]?.url)
  );

  if (!sourceMessage) {
    throw new Error(`No existing ${preview.name} patch-note message found to preview`);
  }

  const sourceEmbed = sourceMessage.embeds[0];
  const embed = EmbedBuilder.from(sourceEmbed).setColor('#FFFFFF');
  const targetUrl = sourceEmbed.url;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Read full patch notes')
      .setStyle(ButtonStyle.Link)
      .setURL(targetUrl)
  );

  await channel.send({ embeds: [embed], components: [row] });
  await client.db?.set?.(preview.markerKey, 'sent').catch(() => {});
  logger.info(`Sent one-time ${preview.name} patch-note style preview.`);
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    for (const preview of PREVIEWS) {
      try {
        await sendPreviewOnce(client, preview);
      } catch (error) {
        logger.warn(`Could not send one-time ${preview.name} patch-note style preview:`, error);
      }
    }
  },
};
