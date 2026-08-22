// rateLimiter.js

import { logger } from './logger.js';

const rateLimitStore = new Map();
const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = 0;

function sweepExpiredEntries(now = Date.now()) {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) {
    return;
  }

  lastSweepAt = now;
  for (const [key, entry] of rateLimitStore) {
    const entryWindowMs = Number(entry?.windowMs) || 60_000;
    if (!entry || now - entry.windowStart >= entryWindowMs) {
      rateLimitStore.delete(key);
    }
  }
}

export async function checkRateLimit(key, maxAttempts = 5, windowMs = 60000) {
  try {
    const now = Date.now();
    sweepExpiredEntries(now);

    const normalizedWindowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60000;
    const normalizedMaxAttempts = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 5;
    const entry = rateLimitStore.get(key);

    if (!entry || now - entry.windowStart >= normalizedWindowMs) {
      rateLimitStore.set(key, {
        count: 1,
        windowStart: now,
        windowMs: normalizedWindowMs,
      });
      return true;
    }

    entry.windowMs = normalizedWindowMs;

    if (entry.count < normalizedMaxAttempts) {
      entry.count++;
      return true;
    }

    logger.debug(`Rate limit exceeded for ${key}`);
    return false;
  } catch (error) {
    logger.error('Error checking rate limit:', error);
    return true;
  }
}

export function getRateLimitStatus(key, windowMs = 60000) {
  const now = Date.now();
  sweepExpiredEntries(now);

  const normalizedWindowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60000;
  const entry = rateLimitStore.get(key);
  if (!entry) {
    return { limited: false, remaining: normalizedWindowMs, attempts: 0 };
  }

  const elapsed = now - entry.windowStart;
  if (elapsed >= normalizedWindowMs) {
    rateLimitStore.delete(key);
    return { limited: false, remaining: normalizedWindowMs, attempts: 0 };
  }

  const remaining = Math.max(0, normalizedWindowMs - elapsed);

  return {
    limited: remaining > 0,
    remaining,
    attempts: entry.count,
  };
}

export function clearRateLimit(key) {
  rateLimitStore.delete(key);
}

export function clearAllRateLimits() {
  rateLimitStore.clear();
  lastSweepAt = 0;
  logger.info('All rate limits cleared');
}
