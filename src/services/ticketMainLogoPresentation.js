import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import {
  getTicketWelcomeLogoLayout,
  TICKET_WELCOME_LOGO_FILENAME,
} from './ticketWelcomeLogoService.js';
import { logger } from '../utils/logger.js';

const inFlight = new Set();

function isMainCloudyTicketMessage(message) {
  return Boolean(
    message?.guild?.id
    && message.author?.id === message.client.user?.id
    && message.embeds?.[0]?.title?.startsWith('Ticket #')
  );
}

function alreadyHasTicketWelcomeLogo(message) {
  const imageUrl = message?.embeds?.[0]?.image?.url || '';
  return imageUrl.includes(TICKET_WELCOME_LOGO_FILENAME);
}

export async function ensureExactWelcomeLogoOnTicket(message) {
  if (!isMainCloudyTicketMessage(message)) return false;
  if (alreadyHasTicketWelcomeLogo(message)) return true;
  if (inFlight.has(message.id)) return false;

  inFlight.add(message.id);
  try {
    const existingAttachment = message.attachments?.find?.(
      attachment => attachment.name === TICKET_WELCOME_LOGO_FILENAME,
    );

    const embed = new EmbedBuilder(message.embeds[0].toJSON());
    const payload = {};

    if (existingAttachment?.url) {
      embed.setImage(existingAttachment.url);
    } else {
      embed.setImage(`attachment://${TICKET_WELCOME_LOGO_FILENAME}`);
      payload.files = [
        new AttachmentBuilder(getTicketWelcomeLogoLayout(), {
          name: TICKET_WELCOME_LOGO_FILENAME,
        }),
      ];
    }

    payload.embeds = [embed];
    await message.edit(payload);
    return true;
  } catch (error) {
    logger.warn('Could not apply exact welcome C logo to ticket message', {
      guildId: message?.guild?.id,
      channelId: message?.channel?.id,
      messageId: message?.id,
      error: error.message,
    });
    return false;
  } finally {
    inFlight.delete(message.id);
  }
}
