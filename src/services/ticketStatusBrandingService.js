import {
  CLOUDY_TICKET_FOOTER,
  TICKET_REPLY_DELETE_MS,
} from '../utils/ticket/ticketBranding.js';
import { getGuildConfig } from './config/guildConfig.js';

const AUTO_DELETE_TITLES = new Set([
  'Ticket reopened',
  'Ticket claimed',
  'Ticket unclaimed',
  'Priority Updated',
  'Ticket pinned',
  'Ticket unpinned',
]);

const deleteTimers = new Map();

function scheduleDelete(message) {
  if (!message?.id || deleteTimers.has(message.id)) return;

  const timer = setTimeout(async () => {
    deleteTimers.delete(message.id);
    await message.delete().catch(() => {});
  }, TICKET_REPLY_DELETE_MS);
  timer.unref?.();
  deleteTimers.set(message.id, timer);
}

export async function brandTicketStatusMessage(message, client) {
  if (!message?.guild?.id || !message?.id) return false;
  if (message.author?.id !== client.user?.id) return false;

  // Ticket lifecycle logs are permanent records. They must keep the colors
  // assigned by ticketLogging.js and must never be auto-deleted or restyled
  // by the temporary in-ticket status-message branding.
  const config = await getGuildConfig(client, message.guild.id).catch(() => null);
  if (
    message.channelId === config?.ticketLogsChannelId
    || message.channelId === config?.ticketTranscriptChannelId
  ) {
    return false;
  }

  const embed = message.embeds?.[0];
  const title = embed?.title;
  if (!AUTO_DELETE_TITLES.has(title)) return false;

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

  scheduleDelete(message);
  return true;
}
