import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { logger } from '../utils/logger.js';

export const TICKET_PANEL_TITLE = 'Contact the support';
export const TICKET_PANEL_BUTTON_EMOJI = '💬';
export const TICKET_PANEL_FOOTER = 'Cloudy Support';

function getCreateTicketButton(message) {
  for (const row of message?.components || []) {
    for (const component of row.components || []) {
      if (component.customId === 'create_ticket') return component;
    }
  }
  return null;
}

function getDesiredButtonLabel(button) {
  const currentLabel = button?.label?.trim();
  if (!currentLabel || currentLabel === 'Create Ticket') return 'Start Chat';
  return currentLabel;
}

export function isTicketPanelMessage(message) {
  return Boolean(getCreateTicketButton(message));
}

function isAlreadyStyled(message, button, avatarUrl) {
  const embed = message.embeds?.[0];
  const emojiName = button?.emoji?.name || null;
  const desiredLabel = getDesiredButtonLabel(button);

  return Boolean(
    embed?.title === TICKET_PANEL_TITLE
      && button?.label === desiredLabel
      && button?.style === ButtonStyle.Secondary
      && emojiName === TICKET_PANEL_BUTTON_EMOJI
      && embed?.footer?.text === TICKET_PANEL_FOOTER
      && (!avatarUrl || embed?.thumbnail?.url)
  );
}

export async function applyTicketPanelPresentation(message) {
  try {
    if (!message?.editable || !message?.embeds?.length) return false;

    const button = getCreateTicketButton(message);
    if (!button) return false;

    const desiredLabel = getDesiredButtonLabel(button);
    const avatarUrl = message.client.user?.displayAvatarURL?.({ extension: 'png', size: 128 }) || null;
    if (isAlreadyStyled(message, button, avatarUrl)) return false;

    const embed = EmbedBuilder.from(message.embeds[0])
      .setTitle(TICKET_PANEL_TITLE)
      .setFooter({
        text: TICKET_PANEL_FOOTER,
        ...(avatarUrl ? { iconURL: avatarUrl } : {}),
      });

    if (avatarUrl) {
      embed.setThumbnail(avatarUrl);
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('create_ticket')
        .setLabel(desiredLabel)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(TICKET_PANEL_BUTTON_EMOJI),
    );

    await message.edit({
      embeds: [embed],
      components: [row],
    });

    return true;
  } catch (error) {
    logger.warn('Could not apply ticket panel presentation', {
      messageId: message?.id,
      channelId: message?.channelId,
      guildId: message?.guildId,
      error: error.message,
    });
    return false;
  }
}
