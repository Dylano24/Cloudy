import { createEmbed } from '../embeds.js';

export const CLOUDY_TICKET_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
export const TICKET_REPLY_DELETE_MS = 2 * 60 * 1000;

// Kept for compatibility with existing imports. The current ticket layout is logo-free.
export const CLOUDY_TICKET_C_IMAGE =
  'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-ticket-c-layout.png';

export function forceCloudyTicketFooter(embed) {
  const payload = typeof embed?.toJSON === 'function' ? embed.toJSON() : { ...(embed || {}) };

  payload.footer = { text: CLOUDY_TICKET_FOOTER };

  // Keep the main ticket message on the current logo-free layout from its
  // first render and remove any legacy thumbnail/image fields.
  if (/^Ticket\s*#\s*\d+/i.test(String(payload.title || ''))) {
    delete payload.thumbnail;
    delete payload.image;
  }

  return payload;
}

export function buildCloudyTicketEmbed({ title = '', description = '', color = '#FFFFFF', fields = [] } = {}) {
  return forceCloudyTicketFooter(createEmbed({ title, description, color, fields }));
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
