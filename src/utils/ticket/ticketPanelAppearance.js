import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { logger } from '../logger.js';

function findCreateTicketButton(message) {
  return message.components
    ?.flatMap(row => row.components || [])
    .find(component => component.customId === 'create_ticket') || null;
}

export async function normalizeTicketPanelMessage(message) {
  try {
    if (!message?.author?.bot || !message.embeds?.length) return false;

    const button = findCreateTicketButton(message);
    if (!button) return false;

    const currentEmbed = message.embeds[0];
    const desiredTitle = 'Contact the support';
    const currentStyle = button.style;
    const alreadyNormalized =
      currentEmbed.title === desiredTitle
      && currentStyle === ButtonStyle.Secondary;

    if (alreadyNormalized) return false;

    const embed = EmbedBuilder.from(currentEmbed).setTitle(desiredTitle);

    const newButton = new ButtonBuilder()
      .setCustomId('create_ticket')
      .setLabel(button.label || 'Start Chat')
      .setStyle(ButtonStyle.Secondary);

    // Keep the current emoji until the exact replacement emoji is provided.
    if (button.emoji?.id) {
      newButton.setEmoji({ id: button.emoji.id, name: button.emoji.name || undefined, animated: Boolean(button.emoji.animated) });
    } else if (button.emoji?.name) {
      newButton.setEmoji(button.emoji.name);
    }

    await message.edit({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(newButton)],
    });

    return true;
  } catch (error) {
    logger.warn('Could not normalize ticket panel appearance', {
      messageId: message?.id,
      channelId: message?.channelId,
      error: error.message,
    });
    return false;
  }
}
