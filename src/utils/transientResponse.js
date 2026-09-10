const TRANSIENT_TTL_MS = 10_000;
const TRANSIENT_TITLE = /^(?:success|warning|error|system error|information|info|notice|done|saved\b.*|updated\b.*|removed\b.*|enabled\b.*|disabled\b.*|cancelled\b.*|canceled\b.*|invalid\b.*|failed\b.*|failure\b.*|wrong\b.*|not found\b.*|not enough\b.*|already\b.*|missing\b.*|access denied\b.*|permission denied\b.*|unavailable\b.*|expired\b.*|could not\b.*|cannot\b.*|can't\b.*|shop unavailable\b.*|staff only\b.*|maintenance mode\b.*|feature disabled\b.*|slash command only\b.*|command disabled\b.*|command cooldown\b.*)/i;

export function isTransientStatusEmbed(embed) {
  const data = embed?.toJSON?.() || embed || {};
  const title = String(data.title || '')
    .replace(/[*_`~]/g, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
  if (!TRANSIENT_TITLE.test(title)) return false;

  const fields = Array.isArray(data.fields) ? data.fields : [];
  return fields.length <= 1 && !data.image && !data.video;
}

export function scheduleTransientMessageDeletion(message) {
  if (!message?.deletable || !message.embeds?.some(isTransientStatusEmbed)) return false;
  const timer = setTimeout(() => message.delete().catch(() => {}), TRANSIENT_TTL_MS);
  timer.unref?.();
  return true;
}

export async function scheduleTransientInteractionReplyDeletion(interaction) {
  if (!interaction?.replied && !interaction?.deferred) return false;
  const reply = await interaction.fetchReply?.().catch(() => null);
  if (!reply?.embeds?.some(isTransientStatusEmbed)) return false;

  const timer = setTimeout(() => interaction.deleteReply?.().catch(() => {}), TRANSIENT_TTL_MS);
  timer.unref?.();
  return true;
}
