import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { logger } from './logger.js';

const observed = Symbol('cloudy.interactionLatency');

// The FAQ assistant is intentionally outside the one-second responsiveness
// objective; keep its LLM requests and user-facing responses untouched.
function isFaqInteraction(interaction) {
  return String(interaction?.customId || '').startsWith('faq_ai_question')
    || /^faq(?:_|$)/i.test(String(interaction?.commandName || ''));
}

function interactionLabel(interaction) {
  const parts = String(interaction?.customId || '').split(':');
  const command = interaction?.commandName || parts[0] || String(interaction?.type || 'component');
  const action = /^[a-z_]+$/i.test(parts[1] || '') ? parts[1] : null;
  return { command, ...(action ? { action } : {}) };
}

// Every sample (fast and slow) per command/action/phase. The slow-only
// warnings above cannot give a real median or p95, so a compact summary of
// each window is logged instead. Bounded: SAMPLE_LIMIT per key, KEY_LIMIT keys.
const SUMMARY_INTERVAL_MS = 15 * 60_000;
const SUMMARY_SAMPLE_LIMIT = 500;
const SUMMARY_KEY_LIMIT = 300;
const latencySamples = new Map();
let summaryTimer = null;
// Event-loop delay shows whether slow acknowledgements come from Discord or
// from synchronous work blocking this process. Sampling is cheap (20 ms).
let loopDelay = null;
const LOOP_DELAY_RESOLUTION_MS = 20;

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function recordInteractionLatencySample(interaction, phase, elapsedMs) {
  try {
    if (!interaction || isFaqInteraction(interaction) || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    const label = interactionLabel(interaction);
    const key = JSON.stringify([label.command, label.action || null, phase]);
    let samples = latencySamples.get(key);
    if (!samples) {
      samples = [];
      latencySamples.set(key, samples);
      while (latencySamples.size > SUMMARY_KEY_LIMIT) latencySamples.delete(latencySamples.keys().next().value);
    }
    samples.push(Math.round(elapsedMs));
    if (samples.length > SUMMARY_SAMPLE_LIMIT) samples.shift();
    if (!summaryTimer) {
      summaryTimer = setInterval(emitInteractionLatencySummary, SUMMARY_INTERVAL_MS);
      summaryTimer.unref?.();
      try {
        loopDelay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
        loopDelay.enable();
      } catch { loopDelay = null; }
    }
  } catch { /* Observability must never interfere with a Discord handler. */ }
}

// Returns (and by default clears) the current window: one row per
// command/action/phase with its sample count, median, p95 and maximum.
export function takeInteractionLatencySummary({ reset = true } = {}) {
  const rows = [];
  for (const [key, samples] of latencySamples) {
    if (!samples.length) continue;
    const [command, action, phase] = JSON.parse(key);
    const sorted = [...samples].sort((a, b) => a - b);
    rows.push({ command, ...(action ? { action } : {}), phase, n: sorted.length,
      p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), maxMs: sorted.at(-1) });
  }
  if (reset) latencySamples.clear();
  return rows.sort((a, b) => b.n - a.n || String(a.command).localeCompare(String(b.command)));
}

export function emitInteractionLatencySummary({
  report = data => logger.warn(`[INTERACTION_LATENCY_SUMMARY] ${JSON.stringify(data)}`),
} = {}) {
  try {
    const rows = takeInteractionLatencySummary();
    // Histogram values include the 20 ms sampling interval; report only the
    // extra delay, i.e. time the event loop was blocked.
    const ms = value => Math.max(0, Math.round(Number(value) / 1e6) - LOOP_DELAY_RESOLUTION_MS);
    const eventLoopDelay = loopDelay?.count > 0
      ? { p50Ms: ms(loopDelay.percentile(50)), p99Ms: ms(loopDelay.percentile(99)), maxMs: ms(loopDelay.max) }
      : null;
    loopDelay?.reset();
    if (rows.length) {
      report({ event: 'interaction.latency.summary', windowMinutes: SUMMARY_INTERVAL_MS / 60_000,
        ...(eventLoopDelay ? { eventLoopDelay } : {}), rows });
    }
  } catch { /* Observability must never interfere with a Discord handler. */ }
}

export function recordSlowInteractionCompletion(interaction, elapsedMs, {
  report = data => logger.warn(`[INTERACTION_LATENCY] ${JSON.stringify(data)}`),
} = {}) {
  recordInteractionLatencySample(interaction, 'handler_complete', elapsedMs);
  if (!interaction || isFaqInteraction(interaction) || elapsedMs < 750) return;
  try {
    report({ event: 'interaction.handler.latency', ...interactionLabel(interaction),
      phase: 'handler_complete', elapsedMs: Math.round(elapsedMs) });
  } catch { /* Observability must never interfere with a Discord handler. */ }
}
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
  if (isFaqInteraction(interaction)) return;
  interaction[observed] = true;
  const started = now();
  let acknowledgedAt = null;
  let acknowledgementMethod = null;
  let visible = false;
  const emit = (phase, elapsedMs, thinkingMs) => {
    recordInteractionLatencySample(interaction, phase, elapsedMs);
    if (elapsedMs < 750) return;
    // Instrumentation must never change a successful Discord response into an
    // application error, even if a logger transport fails.
    try {
      report({ event: 'interaction.latency', ...interactionLabel(interaction),
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

const builderStageSamples = new Map();
const BUILDER_SAMPLE_WINDOW = 200;
const BUILDER_STAGE_LIMIT = 64;

// These bounded, process-local windows include fast and slow successful samples.
// Existing slow-interaction logs alone cannot establish a meaningful p50/p95.
export function createBuilderPerformanceTracker(action, {
  now = () => performance.now(),
  report = data => logger.warn(`[BUILDER_PERFORMANCE] ${JSON.stringify(data)}`),
} = {}) {
  const started = now();
  const marked = new Set();
  return phase => {
    try {
      if (marked.has(phase)) return;
      const elapsedMs = Math.max(0, now() - started);
      if (!Number.isFinite(elapsedMs)) return;
      marked.add(phase);
      const key = action + ':' + phase;
      const samples = builderStageSamples.get(key) || [];
      samples.push(elapsedMs);
      if (samples.length > BUILDER_SAMPLE_WINDOW) samples.shift();
      builderStageSamples.set(key, samples);
      if (builderStageSamples.size > BUILDER_STAGE_LIMIT) {
        builderStageSamples.delete(builderStageSamples.keys().next().value);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      report({
        event: 'builder.stage.latency', action, phase,
        elapsedMs: Math.round(elapsedMs), sampleCount: samples.length,
        p50Ms: Math.round(sorted[Math.ceil(sorted.length * 0.5) - 1]),
        p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
      });
    } catch { /* Monitoring must never block a successful Builder interaction. */ }
  };
}
