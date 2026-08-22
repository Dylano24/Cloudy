import { ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';

function getCustomId(component) {
  return component?.customId || component?.data?.custom_id || null;
}

function isTicketMainMessage(message) {
  return Boolean(
    message?.author?.id === message?.client?.user?.id
    && message?.embeds?.[0]?.title?.startsWith('Ticket #'),
  );
}

function currentLayoutIds(message) {
  return message.components.map(row => row.components.map(getCustomId));
}

function alreadyUsesCloudyLayout(message) {
  const ids = currentLayoutIds(message);
  return ids.length === 3
    && ['ticket_claim', 'ticket_unclaim'].includes(ids[0]?.[0])
    && ids[0]?.[1] === 'ticket_close'
    && ids[1]?.[0] === 'ticket_priority_menu'
    && ids[2]?.[0] === 'ticket_pin';
}

export async function enforceTicketControlLayout(message) {
  if (!isTicketMainMessage(message) || alreadyUsesCloudyLayout(message)) return false;

  const buttons = new Map();
  for (const row of message.components || []) {
    for (const component of row.components || []) {
      const customId = getCustomId(component);
      if (customId) buttons.set(customId, component);
    }
  }

  const claim = buttons.get('ticket_claim') || buttons.get('ticket_unclaim');
  const close = buttons.get('ticket_close');
  const priority = buttons.get('ticket_priority_menu');
  const pin = buttons.get('ticket_pin');

  if (!claim || !close || !priority || !pin) return false;

  try {
    await message.edit({
      components: [
        new ActionRowBuilder().addComponents(ButtonBuilder.from(claim), ButtonBuilder.from(close)),
        new ActionRowBuilder().addComponents(ButtonBuilder.from(priority)),
        new ActionRowBuilder().addComponents(ButtonBuilder.from(pin)),
      ],
    });
    return true;
  } catch (error) {
    logger.warn('Could not enforce ticket control layout', {
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      error: error.message,
    });
    return false;
  }
}
