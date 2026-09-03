const TICKET_LOG_TEMPLATES = [
  { key: 'unclaim', label: 'Ticket unclaimed', fields: ['unclaimed by'] },
  { key: 'claim', label: 'Ticket claimed', fields: ['claimed by'] },
  { key: 'close', label: 'Ticket closed', fields: ['closed by'] },
  { key: 'delete', label: 'Ticket deleted', fields: ['deleted by'] },
  { key: 'unpin', label: 'Ticket unpinned', fields: ['unpinned by'] },
  { key: 'pin', label: 'Ticket pinned', fields: ['pinned by'] },
  { key: 'priority', label: 'Priority updated', fields: ['priority', 'updated by'] },
  { key: 'feedback', label: 'Feedback received', fields: ['rating'] },
];

function cleanFieldName(value) {
  return String(value || '')
    .replace(/<a?:[^:>]+:\d+>/g, ' ')
    .replace(/[^a-z0-9&\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/<a?:[^:>]+:\d+>/g, ' ')
    .replace(/[^a-z0-9\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Identify permanent ticket log embeds from their stable field structure.
 * Title-only ticket status messages inside live ticket channels deliberately
 * do not match this classifier.
 */
export function getTicketLogTemplate(embed) {
  const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : (embed || {});
  const fields = new Set((Array.isArray(data.fields) ? data.fields : [])
    .map(field => cleanFieldName(field?.name))
    .filter(Boolean));

  if (!fields.has('ticket')) return null;

  for (const template of TICKET_LOG_TEMPLATES) {
    if (template.fields.every(field => fields.has(field))) {
      return { key: template.key, label: template.label };
    }
  }

  if (fields.has('creator') && fields.has('messages')) {
    return { key: 'transcript', label: 'Transcript generated' };
  }

  const title = cleanTitle(data.title);
  if (fields.has('creator') && (fields.has('channel') || title === 'ticket created')) {
    return { key: 'open', label: 'Ticket created' };
  }
  if (fields.has('creator') && title === 'transcript generated') {
    return { key: 'transcript', label: 'Transcript generated' };
  }

  return null;
}

export function isTicketLogTemplateChannel(config, channelId) {
  const id = String(channelId || '');
  if (!id) return false;
  return [config?.ticketLogsChannelId, config?.ticketTranscriptChannelId]
    .filter(Boolean)
    .some(configuredId => String(configuredId) === id);
}
