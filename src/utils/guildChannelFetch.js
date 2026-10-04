// Share only requests that are currently running. Each later lookup still
// fetches fresh Discord channel data; there is no lasting authorization cache.
const pendingFetches = new WeakMap();

export function fetchGuildChannels(guild) {
  const manager = guild.channels;
  const pending = pendingFetches.get(manager);
  if (pending) return pending;

  const request = Promise.resolve().then(() => manager.fetch());
  pendingFetches.set(manager, request);
  void request.finally(() => {
    if (pendingFetches.get(manager) === request) pendingFetches.delete(manager);
  }).catch(() => {});
  return request;
}
