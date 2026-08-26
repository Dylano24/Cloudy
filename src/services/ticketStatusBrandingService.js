import {
  CLOUDY_TICKET_FOOTER,
} from '../utils/ticket/ticketBranding.js';
import { getGuildConfig } from './config/guildConfig.js';

const TICKET_STATUS_TITLES = new Set([
  'Ticket reopened',
  'Ticket claimed',
  'Ticket unclaimed',
  'Priority Updated',
  'Ticket pinned',
  'Ticket unpinned',
]);

export async function brandTicketStatusMessage(message, client) {
  if (!message?.guild?.id || !message?.id) return false;
  if (message.author?.id !== client.user?.id) return false;

  // Ticket lifecycle logs are permanent records. They must keep the colors
  // assigned by ticketLogging.js and must never be restyled by the
  // in-ticket status-message branding.
  const config = await getGuildConfig(client, message.guild.id).catch(() => null);
  if (
    message.channelId === config?.ticketLogsChannelId
    || message.channelId === config?.ticketTranscriptChannelId
  ) {
    return false;
  }

  const embed = message.embeds?.[0];
  const title = embed?.title;
  if (!TICKET_STATUS_TITLES.has(title)) return false;

  const raw = embed.toJSON();
  const alreadyBranded = raw.color === 0xFFFFFF
    && raw.footer?.text === CLOUDY_TICKET_FOOTER;

  if (!alreadyBranded) {
    raw.color = 0xFFFFFF;
    raw.footer = { text: CLOUDY_TICKET_FOOTER };
    await message.edit({
      embeds: [raw],
      components: message.components,
    }).catch(() => {});
  }

  return true;
}
