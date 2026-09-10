const TRANSIENT_TTL_MS = 10_000;
const TRANSIENT_TITLE = /^(?:success|warning|error|system error|information|info|notice|done|saved\b.*|updated\b.*|removed\b.*|enabled\b.*|disabled\b.*|cancelled\b.*|canceled\b.*|invalid\b.*|failed\b.*|failure\b.*|wrong\b.*|not found\b.*|not enough\b.*|already\b.*|missing\b.*|access denied\b.*|permission denied\b.*|unavailable\b.*|expired\b.*|could not\b.*|cannot\b.*|can't\b.*|shop unavailable\b.*|staff only\b.*|maintenance mode\b.*|feature disabled\b.*|slash command only\b.*|command disabled\b.*|command cooldown\b.*)/i;
const TRANSIENT_CONTENT = /^(?:[✅❌⚠️ℹ️☑️🟢🔴🟡]\s*)?(?:success(?:fully)?\b|warning\b|error\b|invalid\b|wrong channel\b|failed\b|failure\b|could not\b|cannot\b|can't\b|permission denied\b|access denied\b|not found\b|not enough\b|already\b|missing\b|unavailable\b|expired\b|saved\b|updated\b|removed\b|enabled\b|disabled\b|cancelled\b|canceled\b|done\b|you need\b|you do not have\b|you don't have\b|no active\b)/i;
const PERSISTENT_CHANNEL = /(?:^|[-_\s│])(?:bot-?logs?|logs?|transcripts?|ticket-logs?|ticket-transcripts?|posted-reviews|staff-reviews)(?:$|[-_\s│])/i;

function cleanLeadingStatusText(value = '') {
  return String(value || '')
    .replace(/[*_`~]/g, '')
    .replace(/^[^\p{L}\p{N}✅❌⚠️ℹ️☑️🟢🔴🟡]+/u, '')
    .trim();
}

export function isTransientStatusEmbed(embed) {
  const data = embed?.toJSON?.() || embed || {};
  const title = cleanLeadingStatusText(data.title);
  if (!TRANSIENT_TITLE.test(title)) return false;

  const fields = Array.isArray(data.fields) ? data.fields : [];
  return fields.length <= 1 && !data.image && !data.video;
}

export function isTransientStatusContent(content = '') {
  const body = cleanLeadingStatusText(content);
  if (!body || body.length > 1200) return false;
  return TRANSIENT_CONTENT.test(body);
}

export function isTransientStatusPayload(payload = null, message = null) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const embeds = source.embeds || message?.embeds || [];
  const content = source.content ?? message?.content ?? '';
  return embeds.some(isTransientStatusEmbed) || isTransientStatusContent(content);
}

export function isPersistentBotMessage(message) {
  const channelName = String(message?.channel?.name || '').trim();
  return Boolean(channelName && PERSISTENT_CHANNEL.test(channelName));
}

export function scheduleTransientMessageDeletion(message) {
  if (!message || isPersistentBotMessage(message) || !isTransientStatusPayload(null, message)) return false;
  if (!message.deletable || typeof message.delete !== 'function') return false;

  const timer = setTimeout(() => message.delete().catch(() => {}), TRANSIENT_TTL_MS);
  timer.unref?.();
  return true;
}

export async function scheduleTransientInteractionReplyDeletion(interaction) {
  if (!interaction?.replied && !interaction?.deferred) return false;
  const reply = await interaction.fetchReply?.().catch(() => null);
  if (!reply || !isTransientStatusPayload(null, reply)) return false;

  const timer = setTimeout(() => interaction.deleteReply?.().catch(() => {}), TRANSIENT_TTL_MS);
  timer.unref?.();
  return true;
}
