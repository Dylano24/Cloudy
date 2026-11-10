import { createEmbed } from './embeds.js';
import { REPORT_MODERATION_FOOTER } from './reportCasePrivacy.js';

// The message menu and slash command use one identical private confirmation.
export function buildReportSubmittedEmbed({ reportNumber, reportedMemberId, reportedMessageText, reason }) {
  const message = String(reportedMessageText || '').trim().slice(0, 1024) || 'No message text available.';
  const submittedReason = String(reason || '').trim().slice(0, 1024) || 'No reason provided.';
  const fields = [
    { name: 'Reported member', value: '<@' + reportedMemberId + '>' },
    { name: 'Reported message', value: message },
    { name: 'Report reason', value: submittedReason },
  ];
  const embed = createEmbed({
    title: 'Report submitted',
    description: 'Your report has been successfully submitted to our moderation team.'
      + '\n\nThank you for bringing this to our attention. Our team will review the reported message and take appropriate action if necessary.',
    fields,
  });
  // Preserve the reporter's exact message and reason, including emoji and whitespace.
  // The generic embed formatter sanitizes field text for unrelated message types.
  embed.data.fields = fields;
  embed.setColor(0xFFFFFF);
  // The generic embed builder suppresses nonstandard footer text; set this
  // explicitly so both paths retain the requested moderation-team signature.
  embed.data.footer = { text: `${REPORT_MODERATION_FOOTER} • R${reportNumber}` };
  return embed;
}
