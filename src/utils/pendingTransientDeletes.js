// 10-second status replies are removed by in-memory timers. A restart (deploy)
// would lose those timers and leave the replies on screen, so every pending
// removal is also kept here and run at once during a graceful shutdown.
const pending = new Map();

export function registerPendingDelete(key, run) {
  if (key && typeof run === 'function') pending.set(String(key), run);
}

export function unregisterPendingDelete(key) {
  pending.delete(String(key));
}

export function pendingDeleteCount() {
  return pending.size;
}

/** Runs every pending removal now (at most `maxMs`), e.g. just before shutdown. */
export async function flushPendingDeletes(maxMs = 3_000) {
  const runs = [...pending.values()];
  pending.clear();
  if (!runs.length) return 0;
  let timer;
  await Promise.race([
    Promise.allSettled(runs.map(run => Promise.resolve().then(run))),
    new Promise(resolve => { timer = setTimeout(resolve, maxMs); }),
  ]);
  clearTimeout(timer);
  return runs.length;
}
