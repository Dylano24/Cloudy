import { createEmbed } from '../embeds.js';

export const CLOUDY_TICKET_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
export const TICKET_REPLY_DELETE_MS = 2 * 60 * 1000;

// Exact same source asset used by the welcome message.
// The logo itself stays unchanged; only transparent empty space is added on
// the left so Discord renders that exact C at the bottom-right of the embed.
const CLOUDY_WELCOME_C_LOGO =
  'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo.png';
export const CLOUDY_TICKET_C_FOOTER_IMAGE =
  `https://images.weserv.nl/?url=${encodeURIComponent(CLOUDY_WELCOME_C_LOGO)}`
  + '&w=1600&h=500&fit=contain&a=bottom-right&we=1&cbg=00000000&output=png';

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
