import { getGuildConfig } from './config/guildConfig.js';
import {
  buildTicketPanelPayload,
  DEFAULT_TICKET_BUTTON_LABEL,
} from './ticketPanelBuilder.js';
import { logger } from '../utils/logger.js';

export const TICKET_PANEL_TITLE = 'Contact the support';
export const TICKET_PANEL_BUTTON_EMOJI = '💬';

function getCreateTicketButton(message) {
  for (const row of message?.components || []) {
    for (const component of row.components || []) {
      if (component.customId === 'create_ticket') return component;
    }
  }
  return null;
}

export function isTicketPanelMessage(message) {
  return Boolean(getCreateTicketButton(message));
}

function payloadMatches(message, desired) {
  try {
    const currentEmbeds = (message.embeds || []).map(embed => embed.toJSON());
    const currentComponents = (message.components || []).map(row => row.toJSON());
    return JSON.stringify(currentEmbeds) === JSON.stringify(desired.embeds || [])
      && JSON.stringify(currentComponents) === JSON.stringify(
        (desired.components || []).map(row => typeof row?.toJSON === 'function' ? row.toJSON() : row),
      );
  } catch {
    return false;
  }
}

export async function applyTicketPanelPresentation(message) {
  try {
    if (!message?.editable || !message?.guildId || !isTicketPanelMessage(message)) return false;

    const config = await getGuildConfig(message.client, message.guildId).catch(() => ({}));
    const existingButton = getCreateTicketButton(message);
    const desiredConfig = {
      ...config,
      ticketButtonLabel:
        config?.ticketButtonLabel
        || existingButton?.label
        || DEFAULT_TICKET_BUTTON_LABEL,
    };

    const desired = buildTicketPanelPayload(message.client, message.guildId, desiredConfig);
    if (payloadMatches(message, desired)) return false;

    await message.edit(desired);
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
