import { InteractionHelper } from './interactionHelper.js';
import { isTransientStatusEmbed } from './transientResponse.js';

export const DASHBOARD_IDLE_MS = 5 * 60_000;
export const TRANSIENT_MESSAGE_MS = 10_000;
const PATCH_MARKER = Symbol.for('cloudy.interaction-message-lifecycle');
const dashboardTimers = new Map();
const transientTimers = new Map();
const DASHBOARD_CUSTOM_ID = /^(?:ticket_dashboard_|jtc_|jointocreate_|simple_embed_|cmdaccess_|config_|verification_|verify_|autoverify_|greet_|welcome_|goodbye_|level_|logging_|log_|economy_|application_|app_admin_|reactroles?_|reaction_role_)/i;
const DASHBOARD_TITLE = /(?:dashboard|configuration|configure|setup wizard|command access|message builder|modify embed)/i;

const embedData = embed => embed?.toJSON?.() || embed || {};
function componentIds(components = []) {
  return components.flatMap(row => {
    const data = row?.toJSON?.() || row || {};
    return (data.components || []).map(component => {
      const item = component?.toJSON?.() || component || {};
      return String(item.custom_id || item.customId || '');
    });
  });
}
function isDashboardPayload(payload, message) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const embeds = source.embeds || message?.embeds || [];
  const components = source.components || message?.components || [];
  return components.length > 0 && (componentIds(components).some(id => DASHBOARD_CUSTOM_ID.test(id))
    || embeds.some(embed => DASHBOARD_TITLE.test(String(embedData(embed).title || ''))));
}
function clearTimer(store, messageId) {
  const key = String(messageId || '');
  const timer = store.get(key);
  if (timer) clearTimeout(timer);
  store.delete(key);
}
function schedule(store, message, interaction, delay) {
  if (!message?.id) return;
  const key = String(message.id);
  clearTimer(store, key);
  const timer = setTimeout(() => {
    store.delete(key);
    Promise.resolve(message.delete?.() || interaction.webhook?.deleteMessage?.(message.id)).catch(() => {});
  }, delay);
  timer.unref?.();
  store.set(key, timer);
}
async function resolveResponseMessage(interaction, result) {
  if (result?.id) return result;
  if (interaction?.message?.id) return interaction.message;
  return interaction.fetchReply?.().catch(() => null) || null;
}
export function installInteractionMessageLifecycle() {
  if (InteractionHelper[PATCH_MARKER]) return;
  const previousPatch = InteractionHelper.patchInteractionResponses.bind(InteractionHelper);
  InteractionHelper.patchInteractionResponses = function patchMessageLifecycles(interaction) {
    previousPatch(interaction);
    if (!interaction || interaction.__cloudyMessageLifecyclePatched) return;

    // Any component interaction counts as activity and restarts the 5-minute idle timer,
    // including deferUpdate-only interactions that do not send or edit a response.
    if (interaction.message && isDashboardPayload(null, interaction.message)) {
      schedule(dashboardTimers, interaction.message, interaction, DASHBOARD_IDLE_MS);
    }

    for (const method of ['reply', 'editReply', 'followUp', 'update']) {
      const original = interaction[method]?.bind(interaction);
      if (!original) continue;
      interaction[method] = async (payload, ...args) => {
        const result = await original(payload, ...args);
        const message = await resolveResponseMessage(interaction, result);
        if (!message) return result;
        if (isDashboardPayload(payload, message)) schedule(dashboardTimers, message, interaction, DASHBOARD_IDLE_MS);
        const embeds = payload?.embeds || message.embeds || [];
        if (embeds.some(isTransientStatusEmbed)) schedule(transientTimers, message, interaction, TRANSIENT_MESSAGE_MS);
        return result;
      };
    }
    interaction.__cloudyMessageLifecyclePatched = true;
  };
  Object.defineProperty(InteractionHelper, PATCH_MARKER, {
    value: true, enumerable: false, configurable: false, writable: false,
  });
}
