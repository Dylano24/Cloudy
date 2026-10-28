// Several MessageUpdate listeners need the full message when Discord only
// sends a partial one (for example after a restart). Without coordination
// each listener fetched the same message on its own: one edit could cost up
// to six identical Discord requests. This helper shares one fetch per message
// and skips it entirely when a listener only handles Cloudy's own messages and
// the author is already known to be someone else.
const pendingFetches = new Map();
const SHARE_FETCH_MS = 2_000;

export async function resolveUpdatedMessage(message, { cloudyOnly = false } = {}) {
  if (!message) return null;
  const botId = message.client?.user?.id;
  const authorId = message.author?.id;
  if (cloudyOnly && authorId && botId && authorId !== botId) return null;
  if (!message.partial) return message;

  const key = String(message.id || '');
  let pending = key ? pendingFetches.get(key) : null;
  if (!pending) {
    pending = Promise.resolve()
      .then(() => message.fetch())
      .catch(() => null);
    if (key) {
      pendingFetches.set(key, pending);
      const timer = setTimeout(() => {
        if (pendingFetches.get(key) === pending) pendingFetches.delete(key);
      }, SHARE_FETCH_MS);
      timer.unref?.();
    }
  }
  const fetched = await pending;
  if (!fetched) return null;
  if (cloudyOnly && (!botId || fetched.author?.id !== botId)) return null;
  return fetched;
}
