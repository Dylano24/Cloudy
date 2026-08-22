import { createEmbed } from '../embeds.js';

export const CLOUDY_TICKET_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
export const TICKET_REPLY_DELETE_MS = 2 * 60 * 1000;
export const CLOUDY_TICKET_C_THUMB_URL =
  'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-ticket-c-layout.png?v=side-of-created-20260822';

export function forceCloudyTicketFooter(embed) {
  // Always add standard Cloudy footer and compact C‑logo thumbnail (shows to the right of fields)
  const payload = typeof embed?.toJSON === 'function' ? embed.toJSON() : { ...(embed || {}) };

  payload.footer = { text: CLOUDY_TICKET_FOOTER };

  if (/^Ticket\s*#\s*\d+/i.test(String(payload.title || ''))) {
    payload.thumbnail = { url: CLOUDY_TICKET_C_THUMB_URL };
  }

  // make sure no large embed image leaks underneath the fields
  delete payload.image;

  return payload;
}

export function buildCloudyTicketEmbed({ title = '', description = '', color = '#FFFFFF', fields = [] } = {}) {
  return forceCloudyTicketFooter(
    createEmbed({ title, description, color, fields }),
  );
}

export function scheduleTicketReplyDeletion(interaction, delayMs = TICKET_REPLY_DELETE_MS) {
  if (!interaction) return;
  const timer = setTimeout(() => {
    interaction.deleteReply().catch(() => {});
  }, delayMs);
  timer.unref?.();
}

export function normalizeTicketNumber(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) return String(parsed);
  return String(value || 'Unknown');
}
