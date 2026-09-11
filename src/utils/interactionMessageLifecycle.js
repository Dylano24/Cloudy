import { Message, MessageFlags } from 'discord.js';
import { InteractionHelper } from './interactionHelper.js';
import { isBuilderSessionMessage } from './builderSessionCleanup.js';
import { isTransientStatusPayload } from './transientResponse.js';

export const DASHBOARD_IDLE_MS = 5 * 60_000;
export const TRANSIENT_MESSAGE_MS = 10_000;
const PATCH_MARKER = Symbol.for('cloudy.interaction-message-lifecycle');
const COLLECTOR_PATCH_MARKER = Symbol.for('cloudy.dashboard-collector-lifecycle');
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

function hasEphemeralFlag(flags) {
  if (flags == null) return false;
  if (typeof flags?.has === 'function') {
    return flags.has(MessageFlags.Ephemeral);
  }

  const raw = typeof flags === 'number' ? flags : flags?.bitfield;
  if (typeof raw === 'bigint') {
    return (raw & BigInt(MessageFlags.Ephemeral)) === BigInt(MessageFlags.Ephemeral);
  }
  if (Number.isFinite(Number(raw))) {
    return (Number(raw) & MessageFlags.Ephemeral) === MessageFlags.Ephemeral;
  }
  return false;
}

export function isEphemeralLifecycleMessage(payload = null, message = null) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return hasEphemeralFlag(source.flags) || hasEphemeralFlag(message?.flags);
}

export function isDashboardSessionPayload(payload = null, message = null) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const embeds = source.embeds || message?.embeds || [];
  const components = source.components || message?.components || [];
  if (!components.length) return false;

  return componentIds(components).some(id => DASHBOARD_CUSTOM_ID.test(id))
    || embeds.some(embed => DASHBOARD_TITLE.test(String(embedData(embed).title || '')));
}

export function normalizeDashboardCollectorOptions(message, options = {}) {
  if (!isEphemeralLifecycleMessage(null, message)) return options;
  if (!isDashboardSessionPayload(null, message)) return options;
  if (options?.idle != null) return options;
  if (Number(options?.time) !== DASHBOARD_IDLE_MS) return options;

  const normalized = { ...options, idle: DASHBOARD_IDLE_MS };
  delete normalized.time;
  return normalized;
}

function installDashboardCollectorLifecycle() {
  const prototype = Message?.prototype;
  if (!prototype || prototype[COLLECTOR_PATCH_MARKER]) return;

  const originalCreateCollector = prototype.createMessageComponentCollector;
  if (typeof originalCreateCollector !== 'function') return;

  prototype.createMessageComponentCollector = function createManagedDashboardCollector(options = {}) {
    return originalCreateCollector.call(this, normalizeDashboardCollectorOptions(this, options));
  };

  Object.defineProperty(prototype, COLLECTOR_PATCH_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function clearTimer(store, messageId) {
  const key = String(messageId || '');
  const timer = store.get(key);
  if (timer) clearTimeout(timer);
  store.delete(key);
}

export async function deleteLifecycleMessage(message, interaction) {
  if (!message?.id) return false;

  // Ephemeral interaction messages must be removed through the webhook route.
  // Try it first, then fall back to a normal Message#delete for public replies.
  if (interaction?.webhook?.deleteMessage) {
    const deleted = await interaction.webhook.deleteMessage(message.id)
      .then(() => true)
      .catch(() => false);
    if (deleted) return true;
  }

  if (typeof message.delete === 'function') {
    const deleted = await message.delete()
      .then(() => true)
      .catch(() => false);
    if (deleted) return true;
  }

  if (interaction?.deleteReply) {
    return interaction.deleteReply()
      .then(() => true)
      .catch(() => false);
  }

  return false;
}

function schedule(store, message, interaction, delay) {
  if (!message?.id) return false;
  const key = String(message.id);
  clearTimer(store, key);

  const timer = setTimeout(() => {
    store.delete(key);
    void deleteLifecycleMessage(message, interaction);
  }, delay);
  timer.unref?.();
  store.set(key, timer);
  return true;
}

export function shouldUseGenericDashboardTimer(payload, message) {
  if (isBuilderSessionMessage(message)) return false;
  if (!isEphemeralLifecycleMessage(payload, message)) return false;
  return isDashboardSessionPayload(payload, message);
}

export function shouldUseTransientTimer(payload, message) {
  // The Message Builder renders the selected embed as its first embed. Titles
  // such as Success, Warning, Information or Could not... are valid preview
  // content and must never make the whole Builder look like a 10-second status
  // reply. Builder lifetime is owned exclusively by builderSessionCleanup.
  if (isBuilderSessionMessage(message)) return false;
  return isTransientStatusPayload(payload, message);
}

function scheduleDashboardIfNeeded(payload, message, interaction) {
  // Message Builder / Modify Embed have a dedicated lifecycle manager that can
  // pause the five-minute timer while the browser editor owns a 14-minute hold.
  // Never attach the generic dashboard timer as well, otherwise it can delete
  // the original reply underneath the web editor and safeEditReply may create a
  // duplicate follow-up on the next preview refresh.
  if (!shouldUseGenericDashboardTimer(payload, message)) return false;
  return schedule(dashboardTimers, message, interaction, DASHBOARD_IDLE_MS);
}

async function resolveResponseMessage(interaction, result) {
  if (result?.id) return result;
  if (interaction?.message?.id) return interaction.message;
  return interaction.fetchReply?.().catch(() => null) || null;
}

export function installInteractionMessageLifecycle() {
  installDashboardCollectorLifecycle();
  if (InteractionHelper[PATCH_MARKER]) return;
  const previousPatch = InteractionHelper.patchInteractionResponses.bind(InteractionHelper);

  InteractionHelper.patchInteractionResponses = function patchMessageLifecycles(interaction) {
    previousPatch(interaction);
    if (!interaction || interaction.__cloudyMessageLifecyclePatched) return;

    // Every click/select interaction on an ephemeral dashboard counts as activity.
    // This makes the five-minute lifetime an inactivity timeout instead of a fixed age.
    if (interaction.message) {
      scheduleDashboardIfNeeded(null, interaction.message, interaction);
    }

    for (const method of ['reply', 'editReply', 'followUp', 'update']) {
      const original = interaction[method]?.bind(interaction);
      if (!original) continue;

      interaction[method] = async (payload, ...args) => {
        const result = await original(payload, ...args);
        const message = await resolveResponseMessage(interaction, result);
        if (!message) return result;

        scheduleDashboardIfNeeded(payload, message, interaction);
        if (shouldUseTransientTimer(payload, message)) {
          schedule(transientTimers, message, interaction, TRANSIENT_MESSAGE_MS);
        }
        return result;
      };
    }

    interaction.__cloudyMessageLifecyclePatched = true;
  };

  Object.defineProperty(InteractionHelper, PATCH_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}
