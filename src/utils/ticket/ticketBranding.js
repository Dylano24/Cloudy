import { createEmbed } from '../embeds.js';

export const CLOUDY_TICKET_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
export const TICKET_REPLY_DELETE_MS = 2 * 60 * 1000;

// Uses the exact same cloudy-c-logo.png bytes as the welcome message.
// The SVG only provides transparent spacing/positioning so the unchanged C
// renders at welcome-thumbnail scale near the bottom-right of ticket embeds.
const CLOUDY_TICKET_C_LAYOUT =
  'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-ticket-c-layout.svg?v=1';
export const CLOUDY_TICKET_C_FOOTER_IMAGE =
  `https://images.weserv.nl/?url=${encodeURIComponent(CLOUDY_TICKET_C_LAYOUT)}&output=png`;

export function forceCloudyTicketFooter(embed) {
  const payload = typeof embed?.toJSON === 'function'
    ? embed.toJSON()
    : { ...(embed || {}) };

  payload.footer = { text: CLOUDY_TICKET_FOOTER };

  if (/^Ticket\s*#\s*\d+/i.test(String(payload.title || ''))) {
    payload.image = { url: CLOUDY_TICKET_C_FOOTER_IMAGE };
    if (Array.isArray(payload.fields)) {
      payload.fields = payload.fields.map(field => ({ ...field, inline: false }));
    }
  }

  return payload;
}

export function buildCloudyTicketEmbed({
  title = '',
  description = '',
  color = '#FFFFFF',
  fields = [],
} = {}) {
  return forceCloudyTicketFooter(createEmbed({
    title,
    description,
    color,
    fields,
  }));
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
