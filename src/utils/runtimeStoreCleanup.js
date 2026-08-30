export function sweepTimestampBuckets(store, cutoff) {
  if (!store?.entries || !Number.isFinite(cutoff)) return 0;

  let removed = 0;
  for (const [key, values] of store.entries()) {
    if (!Array.isArray(values)) {
      store.delete(key);
      removed += 1;
      continue;
    }

    const active = values.filter(value => Number(value) > cutoff);
    if (active.length === 0) {
      store.delete(key);
      removed += 1;
    } else if (active.length !== values.length) {
      store.set(key, active);
    }
  }

  return removed;
}

export function sweepExpiredTimestamps(store, now = Date.now()) {
  if (!store?.entries || !Number.isFinite(now)) return 0;

  let removed = 0;
  for (const [key, expiresAt] of store.entries()) {
    if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) <= now) {
      store.delete(key);
      removed += 1;
    }
  }

  return removed;
}
