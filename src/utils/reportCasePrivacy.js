export const REPORT_MODERATION_FOOTER = 'Cloudy Inc. Moderation team';

export function isReportUpdateTitle(title) {
  return /^(?:(?:Report|Moderation) update|(?:Report|Moderation) n•\d+ (?:update|closed|automatically deleted))$/i.test(String(title || ''));
}

// Separate audiences must never inherit another case's saved description or fields.
export function isPrivateReportCasePayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if ((payload.components || []).some(row => (row.components || row.data?.components || []).some(button =>
    String(button.customId || button.custom_id || button.data?.custom_id || '').startsWith('report_case:')))) return true;
  return (payload.embeds || []).some(embed => {
    const title = embed.title || embed.data?.title;
    return isReportUpdateTitle(title) || /^Report (?:notification|created|closed|deleted|automatically deleted)$/i.test(String(title || ''));
  });
}

export function hasReportActions(message) {
  return message?.components?.some(row =>
    row.components?.some(button => button.customId?.startsWith('report_action:')),
  ) ?? false;
}
