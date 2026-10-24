import { redisEnqueueLatencySample } from './redisCache.js';

// Deliberately restricted to anonymous, best-effort timing telemetry.
// Never include Discord user IDs, message IDs, channel IDs, payloads, tokens,
// reports, ticket content, or any other application data.
function cleanLabel(value, fallback) {
  const label = String(value || '');
  return /^[a-z_]{1,50}$/.test(label) ? label : fallback;
}

export function createAnonymousLatencySample(data, observedAt = new Date()) {
  if (!data || typeof data !== 'object') return null;
  const elapsedMs = Math.round(Number(data.elapsedMs));
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 60_000) return null;
  const date = new Date(observedAt);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    version: 1,
    hour: date.toISOString().slice(0, 13),
    command: cleanLabel(data.command, 'unknown'),
    action: cleanLabel(data.action, 'none'),
    phase: cleanLabel(data.phase, 'unknown'),
    elapsedMs,
  };
}

export function parseAnonymousLatencySample(raw) {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  try {
    const data = JSON.parse(raw);
    if (data?.version !== 1
        || typeof data.hour !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(data.hour)) return null;
    const rebuilt = createAnonymousLatencySample(data, new Date(data.hour + ':00:00.000Z'));
    if (!rebuilt || rebuilt.hour !== data.hour) return null;
    // Reject malformed or user-supplied fields instead of silently converting
    // them into arbitrary counters.
    if (rebuilt.command !== data.command || rebuilt.action !== data.action
        || rebuilt.phase !== data.phase) return null;
    return rebuilt;
  } catch {
    return null;
  }
}

export async function publishAnonymousLatencySample(data, enabled = process.env.CLOUDY_LATENCY_WORKER_EXPORT === '1') {
  if (!enabled) return false;
  const sample = createAnonymousLatencySample(data);
  return sample ? redisEnqueueLatencySample(sample) : false;
}

export async function consumeAnonymousLatencySample(raw, record) {
  const sample = parseAnonymousLatencySample(raw);
  if (!sample) return false;
  const label = [sample.command, sample.action, sample.phase].join(':');
  return Boolean(await record(sample.hour, label, sample.elapsedMs));
}
