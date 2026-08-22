import { createEmbed } from '../embeds.js';

export const CLOUDY_TICKET_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
export const TICKET_REPLY_DELETE_MS = 2 * 60 * 1000;

// Small 128×128 transparent PNG that sits below the fields without huge whitespace.
export const CLOUDY_TICKET_C_IMAGE =
  'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-ticket-c-layout-128.png?v=bottom-right-20260822';

export function forceCloudyTicketFooter(embed) {
  const payload = typeof embed?.toJSON === 'function' ? embed.toJSON() : { ...(embed || {}) };

  payload.footer = { text: CLOUDY_TICKET_FOOTER };

  // Apply the C logo to ticket embeds only.
  if (/^Ticket\s*#\s*\d+/i.test(String(payload.title || ''))) {
    // Remove previous thumbnail padding hacks if present.
    delete payload.thumbnail;

    // Attach as a small image so Discord renders it centred at the very bottom
    // of the embed, effectively bottom‑right because of Discord’s layout.
    payload.image = { url: CLOUDY_TICKET_C_IMAGE };
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
