import { performance } from 'node:perf_hooks';
import { logger } from './logger.js';

const observed = Symbol('cloudy.interactionLatency');
const ACK = new Set(['reply', 'update', 'showModal', 'respond', 'deferReply', 'deferUpdate']);
const VISIBLE = new Set(['reply', 'update', 'showModal', 'respond', 'editReply', 'followUp']);

// Observe successful transport responses, not handler completion. A defer is
// an acknowledgement but never counts as having cleared the thinking state.
export function observeInteractionLatency(interaction, {
  now = () => performance.now(),
  report = data => logger.warn(`[INTERACTION_LATENCY] ${JSON.stringify(data)}`),
} = {}) {
  if (!interaction || interaction[observed] || interaction._isPrefixCommand) return;
  // The user's latency objective applies to all Cloudy interactions, with
  // the AI FAQ assistant explicitly exempt. Do not change its response flow.
  const faq = String(interaction.customId || '').startsWith('faq_ai_question')
    || /^faq(?:_|$)/i.test(String(interaction.commandName || ''));
  if (faq) return;
  interaction[observed] = true;
  const started = now();
  let acknowledgedAt = null;
  let acknowledgementMethod = null;
  let visible = false;
  const emit = (phase, elapsedMs, thinkingMs) => {
    if (elapsedMs < 750) return;
    // Instrumentation must never change a successful Discord response into an
    // application error, even if a logger transport fails.
    try {
      const component = String(interaction.customId || '').split(':');
      const command = interaction.commandName || component[0] || String(interaction.type || 'component');
      const action = /^[a-z_]+$/i.test(component[1] || '') ? component[1] : null;
      report({ event: 'interaction.latency', command, ...(action ? { action } : {}),
        phase, elapsedMs: Math.round(elapsedMs), ...(thinkingMs == null ? {} : { thinkingMs: Math.round(thinkingMs) }) });
    } catch { /* Preserve the original response result. */ }
  };
  for (const method of new Set([...ACK, ...VISIBLE])) {
    const original = interaction[method];
    if (typeof original !== 'function') continue;
    interaction[method] = async function (...args) {
      const result = await original.apply(this, args);
      const finished = now();
      if (acknowledgedAt === null && ACK.has(method)) {
        acknowledgedAt = finished;
        acknowledgementMethod = method;
        emit('ack', finished - started);
      }
      if (!visible && VISIBLE.has(method)) {
        visible = true;
        // deferUpdate silently acknowledges component buttons and does not
        // show Discord's ephemeral thinking placeholder. Only deferReply does.
        emit('visible', finished - started,
          acknowledgementMethod === 'deferReply' ? finished - acknowledgedAt : null);
      }
      return result;
    };
  }
}
