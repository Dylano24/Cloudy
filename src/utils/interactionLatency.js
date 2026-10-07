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
  interaction[observed] = true;
  const started = now();
  let acknowledgedAt = null;
  let visible = false;
  const emit = (phase, elapsedMs, thinkingMs) => {
    if (elapsedMs < 1000) return;
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
        emit('ack', finished - started);
      }
      if (!visible && VISIBLE.has(method)) {
        visible = true;
        emit('visible', finished - started, acknowledgedAt === null ? null : finished - acknowledgedAt);
      }
      return result;
    };
  }
}
