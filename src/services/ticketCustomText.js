// Ticket texts a server sets on the dashboard: the panel and the first message
// in a new ticket. Variables: {user} {reason} {number} {server}. Empty means
// Cloudy's standard text, so servers that never set them see no change.

const LIMITS = { title: 256, message: 4000 };

export function renderTicketTemplate(template, { user = '', reason = '', number = '', server = '' } = {}) {
  return String(template || '')
    .replace(/\{user\}/gi, user)
    .replace(/\{reason\}/gi, reason)
    .replace(/\{number\}/gi, String(number))
    .replace(/\{server\}/gi, server);
}

/** The custom opening title and text for a new ticket, or null for the standard one. */
export function customTicketOpening(config, vars) {
  const title = typeof config?.ticketOpenTitle === 'string' ? config.ticketOpenTitle.trim() : '';
  const message = typeof config?.ticketOpenMessage === 'string' ? config.ticketOpenMessage.trim() : '';
  if (!title && !message) return null;
  let description = message ? renderTicketTemplate(message, vars) : null;
  // The reason always stays visible to staff, also when the text leaves it out.
  if (description && !/\{reason\}/i.test(message) && vars?.reason) description += `\n\n**Reason:** ${vars.reason}`;
  return {
    title: title ? renderTicketTemplate(title, vars).slice(0, LIMITS.title) : null,
    description: description ? description.slice(0, LIMITS.message) : null,
  };
}
