// Wait until a pg Pool has had no checked-out or queued clients for quietMs,
// or until maxMs has passed. Shutdown uses this after Discord events stop so
// work already in flight (a registry cleanup after a bulk delete, a ticket
// save) can finish instead of failing against a closed pool. The quiet period
// covers multi-step writes that briefly release the pool between queries.
export async function waitForPoolIdle(pool, {
  quietMs = 500,
  maxMs = 4000,
  intervalMs = 50,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); }),
} = {}) {
  if (!pool || typeof pool.totalCount !== 'number') return { idle: true, waitedMs: 0 };
  const started = now();
  let quietSince = null;
  while (now() - started < maxMs) {
    const busy = (pool.waitingCount || 0) > 0 || pool.totalCount > (pool.idleCount || 0);
    if (busy) {
      quietSince = null;
    } else if (quietSince === null) {
      quietSince = now();
    } else if (now() - quietSince >= quietMs) {
      return { idle: true, waitedMs: now() - started };
    }
    await sleep(intervalMs);
  }
  return { idle: false, waitedMs: now() - started };
}
