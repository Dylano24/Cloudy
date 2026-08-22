import { createEmbed } from '../embeds.js';

export const CLOUDY_TICKET_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
export const TICKET_REPLY_DELETE_MS = 2 * 60 * 1000;
export const CLOUDY_TICKET_C_THUMB = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-ticket-c-layout.png?v=field-align-20260822';

// Padding to push fields down so the thumbnail lines up with the Created row.
const PAD = '\u200B\n\u200B\n\u200B';

export function forceCloudyTicketFooter(embed) {
  const payload = typeof embed?.toJSON === 'function' ? embed.toJSON() : { ...(embed || {}) };
  payload.footer = { text: CLOUDY_TICKET_FOOTER };

  if (/^Ticket\s*#\s*\d+/i.test(String(payload.title || ''))) {
    payload.thumbnail = { url: CLOUDY_TICKET_C_THUMB };
    delete payload.image;
    if (payload.description && !payload.description.startsWith(PAD)) {
      payload.description = `${PAD}${payload.description}`;
    }
  }
  return payload;
}

export function buildCloudyTicketEmbed({ title = '', description = '', color = '#FFFFFF', fields = [] } = {}) {
  return forceCloudyTicketFooter(
    createEmbed({ title, description, color, fields }),
  );
}

export function scheduleTicketReplyDeletion(interaction, delayMs = TICKET_REPLY_DELETE_MS) {
  if (!interaction) return;
  const timer = setTimeout(() => interaction.deleteReply().catch(() => {}), delayMs);
  timer.unref?.();
}

export function normalizeTicketNumber(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? String(n) : String(value || 'Unknown');
}
