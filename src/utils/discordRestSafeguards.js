import { logger } from './logger.js';

// discord.js already schedules REST requests against Discord's global,
// route and shared buckets, including Discord's retry-after instructions.
// This guard does NOT add another request queue or alter interaction traffic.
const installed = Symbol.for('cloudy.discordRestSafeguards');
const editableMessage = /^\/channels\/\d{17,20}\/messages\/\d{17,20}$/;
const safeOptions = new Set(['body', 'files', 'auth']);
const MAX_BODY_LENGTH = 16_000;
const MAX_PENDING_EDITS = 256;
const RATE_LIMIT_LOG_INTERVAL_MS = 30_000;

function identicalEditKey(method, route, options) {
  if (String(method).toUpperCase() !== 'PATCH' || typeof route !== 'string'
      || !editableMessage.test(route) || !options || typeof options !== 'object') return null;
  if (Object.keys(options).some(key => !safeOptions.has(key))) return null;
  if (!Object.hasOwn(options, 'body') || options.body == null
      || (Array.isArray(options.files) && options.files.length > 0)
      || (options.files != null && !Array.isArray(options.files))) return null;
  let payload;
  try {
    payload = JSON.stringify(options.body);
  } catch {
    return null;
  }
  if (!payload || payload.length > MAX_BODY_LENGTH) return null;
  return JSON.stringify([payload, options.auth ?? true]);
}

function safeRoute(route) {
  const sanitized = String(route || 'unknown').replace(/\d{16,20}/g, ':id');
  // Never print webhook tokens, URLs or arbitrary endpoint parameters.
  return /^\/[a-z_/:\-]+$/i.test(sanitized) ? sanitized : 'other';
}

/**
 * Coalesce only identical overlapping edits to the same physical Discord message.
 * A different edit immediately supersedes the coalescing slot, preserving the
 * order of A -> B -> A. Every edit after an earlier one settles is sent normally.
 * All other operations (including interaction ACK, send, delete, moderation)
 * continue directly through discord.js's native rate-limit scheduler.
 */
export function installDiscordRestSafeguards(rest, {
  onCoalesced = () => {},
  onRateLimit = event => logger.warn('[DISCORD_API] ' + JSON.stringify(event)),
  now = () => Date.now(),
} = {}) {
  if (!rest || typeof rest.request !== 'function') return false;
  if (rest[installed]) return true;

  const original = rest.request;
  const pending = new Map();
  const loggedAt = new Map();
  rest.request = function guardedRequest(method, route, options) {
    const signature = identicalEditKey(method, route, options);
    if (!signature) return original.call(this, method, route, options);

    const existing = pending.get(route);
    if (existing?.signature === signature) {
      try { onCoalesced(); } catch { /* Metrics cannot affect requests. */ }
      return existing.promise;
    }

    // Bypass coalescing under extreme concurrency; never drop a real request.
    if (pending.size >= MAX_PENDING_EDITS && !existing) {
      return original.call(this, method, route, options);
    }

    // Call the original immediately to retain SDK queue ordering.
    const request = Promise.resolve(original.call(this, method, route, options));
    const entry = { signature, promise: null };
    entry.promise = request.finally(() => {
      if (pending.get(route) === entry) pending.delete(route);
    });
    pending.set(route, entry);
    return entry.promise;
  };

  if (typeof rest.on === 'function') {
    rest.on('rateLimited', data => {
      try {
        const route = safeRoute(data?.route);
        const method = String(data?.method || 'unknown').toUpperCase();
        const key = method + ':' + route;
        const timestamp = now();
        const previous = loggedAt.get(key) ?? -Infinity;
        if (timestamp - previous < RATE_LIMIT_LOG_INTERVAL_MS) return;
        loggedAt.set(key, timestamp);
        if (loggedAt.size > 64) loggedAt.delete(loggedAt.keys().next().value);
        onRateLimit({
          event: 'discord.rest.rate_limited',
          method,
          route,
          scope: ['global', 'user', 'shared'].includes(data?.scope) ? data.scope : 'unknown',
          retryAfterMs: Math.max(0, Number(data?.retryAfter) || 0),
        });
      } catch { /* Observability must never interfere with the SDK. */ }
    });
  }

  rest[installed] = true;
  return true;
}
