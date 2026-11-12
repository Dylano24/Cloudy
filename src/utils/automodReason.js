// How an AutoMod reason is shown in the logs (owner's choice):
// "Automod: message spam detected" -> "Message spam detected (AutoMod)".
// The stored Discord reason keeps its "Automod:" form, which other code
// uses to recognise AutoMod actions.
export function automodReasonText(reason) {
  const text = String(reason || '').replace(/^\s*(?:automod|automatic protection)\s*:\s*/i, '').trim();
  if (!text) return 'AutoMod';
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} (AutoMod)`;
}

// Reason line of a message that was deleted because of a report.
export const REPORTED_MESSAGE_REASON = 'Reported message';
