import { getResponseLifetime } from './responseLifetime.js';
import { isAdditionalStatusTitle, isAdditionalStatusContent } from './statusReplyPolicy.js';
import { isBuilderSessionMessage } from './builderSessionCleanup.js';

const TRANSIENT_TTL_MS = 10_000;
const transientPayloads = new WeakSet();
export function rememberTransientPayloadIntent(original, outgoing) {
  if (outgoing && typeof outgoing === 'object' && isTransientStatusPayload(original)) {
    transientPayloads.add(outgoing);
  }
  return outgoing;
}
const STATUS_EMOJI_PREFIX = /^(?:(?:✅|❌|⚠️?|ℹ️?|☑️?|🟢|🔴|🟡)\s*)+/u;
const TRANSIENT_TITLE = /^(?:success|warning|error|system error|information|info|notice|done|saved\b.*|updated\b.*|removed\b.*|enabled\b.*|disabled\b.*|cancelled\b.*|canceled\b.*|invalid\b.*|failed\b.*|failure\b.*|wrong\b.*|not found\b.*|not enough\b.*|already\b.*|missing\b.*|access denied\b.*|permission denied\b.*|unavailable\b.*|expired\b.*|could not\b.*|cannot\b.*|can't\b.*|shop unavailable\b.*|staff only\b.*|maintenance mode\b.*|feature disabled\b.*|slash command only\b.*|command disabled\b.*|command cooldown\b.*)/i;
const TRANSIENT_CONTENT = /^(?:(?:✅|❌|⚠️?|ℹ️?|☑️?|🟢|🔴|🟡)\s*)?(?:success(?:fully)?\b|warning\b|information\b|info\b|notice\b|error\b|invalid\b|wrong channel\b|failed\b|failure\b|could not\b|cannot\b|can't\b|permission denied\b|access denied\b|not found\b|not enough\b|already\b|missing\b|unavailable\b|expired\b|saved\b|updated\b|removed\b|enabled\b|disabled\b|cancelled\b|canceled\b|done\b|you need\b|you do not have\b|you don't have\b|no active\b|choose one of the (?:staff members|owners) first\b|the review selectors could not be updated\b|that member is no longer available for staff reviews\b|this review session expired\b|the community reviews channel is currently unavailable\b|the staff review could not be published\b|your staff review has been published\b)/iu;
const PERSISTENT_CHANNEL = /(?:^|[-_\s│])(?:bot-?logs?|logs?|transcripts?|ticket-logs?|ticket-transcripts?|reports?|posted-reviews|staff-reviews)(?:$|[-_\s│])/i;

function cleanLeadingStatusText(value = '') {
  return String(value || '')
    .replace(/[*_`~]/g, '')
    .trimStart()
    .replace(STATUS_EMOJI_PREFIX, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
}

export function isTransientStatusEmbed(embed) {
  const data = embed?.toJSON?.() || embed || {};
  const title = cleanLeadingStatusText(data.title);
  if (!TRANSIENT_TITLE.test(title) && !isAdditionalStatusTitle(title)) return false;

  const fields = Array.isArray(data.fields) ? data.fields : [];
  return (fields.length <= 1 || isAdditionalStatusTitle(title)) && !data.image && !data.video;
}

export function isTransientStatusContent(content = '') {
  const body = cleanLeadingStatusText(content);
  if (!body || body.length > 1200) return false;
  return TRANSIENT_CONTENT.test(body) || isAdditionalStatusContent(body);
}

export function isTransientStatusPayload(payload = null, message = null) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const embeds = source.embeds || message?.embeds || [];
  const content = source.content ?? message?.content ?? '';
  // A catalog or a normal embed with an attached status is permanent content.
  if (String(content).includes('System & error embed templates')) return false;
  if (embeds.length && !embeds.every(isTransientStatusEmbed)) return transientPayloads.has(source);
  return transientPayloads.has(source) || embeds.some(isTransientStatusEmbed) || isTransientStatusContent(content);
}

export function isPersistentBotMessage(message) {
  if (/^report-\d+$/.test(String(message?.channel?.name || ''))) return true;
  if ((message?.components || []).some(row => (row.components || []).some(button => /^report_case:/.test(button.customId || button.custom_id || '')))) return true;
  const channelName = String(message?.channel?.name || '').trim();
  return Boolean(channelName && PERSISTENT_CHANNEL.test(channelName));
}

export function scheduleTransientMessageDeletion(message) {
  // Message Builder / Modify Embed own their lifetime through builderSessionCleanup.
  // Never let a status-like preview route the whole Builder into the 10s cleanup.
  if (!message || isBuilderSessionMessage(message) || isPersistentBotMessage(message) || !isTransientStatusPayload(null, message)) return false;
  if (!message.deletable || typeof message.delete !== 'function') return false;

  const timer = setTimeout(() => {
    // A split Embed Builder preview can be registered immediately after the
    // Discord reply resolves. Re-check ownership at deletion time so a timer
    // scheduled a few milliseconds earlier can never delete Builder UI.
    if (isBuilderSessionMessage(message)) return;
    void message.delete().catch(() => {});
  }, TRANSIENT_TTL_MS);
  timer.unref?.();
  return true;
}

export async function scheduleTransientInteractionReplyDeletion(interaction) {
  // BUILDER_PREVIEW_LIFETIME_V2_FINAL_GUARD: /embedbuilder owns its original preview lifetime.
  if (String(interaction?.commandName || '').trim().toLowerCase() === 'embedbuilder') return false;
  // The lifecycle owns explicit exceptions, including the 120-second report acknowledgement.
  // Never add a competing 10-second timer after command.execute().
  if (getResponseLifetime(interaction) !== undefined) return false;
  if (!interaction?.replied && !interaction?.deferred) return false;
  const reply = await interaction.fetchReply?.().catch(() => null);
  // This helper is used outside interactionMessageLifecycle too, so enforce the
  // Builder exclusion here at the final deletion boundary as well.
  if (!reply || isBuilderSessionMessage(reply) || !isTransientStatusPayload(null, reply)) return false;

  const timer = setTimeout(() => interaction.deleteReply?.().catch(() => {}), TRANSIENT_TTL_MS);
  timer.unref?.();
  return true;
}
