// Separate audiences must never inherit another case's saved description or fields.
export function isPrivateReportCasePayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if ((payload.components || []).some(row => (row.components || row.data?.components || []).some(button =>
    String(button.customId || button.custom_id || button.data?.custom_id || '').startsWith('report_case:')))) return true;
  return (payload.embeds || []).some(embed => /^Report case (?:notification|created|closed|deleted)$/i.test(String(embed.title || embed.data?.title || '')));
}
