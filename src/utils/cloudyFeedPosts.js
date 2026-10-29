// Cloudy Feed posts (photos and videos) are Cloudy's own messages, but they
// are channel content like a member's post. Discord echoes a send's nonce in
// its own MESSAGE_CREATE event, so the message handler can recognise a feed
// post even before channel.send() has resolved.
const NONCE_PREFIX = 'cfeed';

export function withCloudyFeedNonce(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  // Discord accepts at most 25 characters.
  const nonce = (NONCE_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).slice(0, 25);
  return { ...payload, nonce };
}

export function isCloudyFeedPost(message) {
  const botId = message?.client?.user?.id;
  return Boolean(botId && message?.author?.id === botId
    && String(message?.nonce ?? '').startsWith(NONCE_PREFIX));
}
