import { readFile } from 'node:fs/promises';

export const START_CHAT_ENLARGED_EMOJI_NAME = 'cloudy_start_chat_large';
export const ORIGINAL_START_CHAT_EMOJI = Object.freeze({
  id: '1568808462782177280',
  name: 'white_bubble',
});
const pending = new WeakMap();

function findEnlargedEmoji(collection) {
  return [...(collection?.values?.() || [])]
    .find(emoji => emoji.name === START_CHAT_ENLARGED_EMOJI_NAME) || null;
}

function emojiData(emoji) {
  return { id: emoji.id, name: emoji.name, animated: Boolean(emoji.animated) };
}

export function startChatEmoji(client) {
  const emoji = findEnlargedEmoji(client?.application?.emojis?.cache);
  return emoji ? emojiData(emoji) : ORIGINAL_START_CHAT_EMOJI;
}

// Application emoji assets can be used by Cloudy's own interaction buttons.
// Create the larger artwork only once; never delete or rename the original emoji.
export async function ensureLargeStartChatEmoji(client) {
  const existingCached = findEnlargedEmoji(client?.application?.emojis?.cache);
  if (existingCached) return emojiData(existingCached);
  if (pending.has(client)) return pending.get(client);
  const work = (async () => {
    const manager = client?.application?.emojis;
    if (!manager?.fetch || !manager?.create) return ORIGINAL_START_CHAT_EMOJI;

    const emojis = await manager.fetch();
    const found = findEnlargedEmoji(emojis);
    const emoji = found || await manager.create({
      name: START_CHAT_ENLARGED_EMOJI_NAME,
      attachment: await readFile(new URL('../../assets/cloudy-start-chat-bubble-large.png', import.meta.url)),
    });
    manager.cache?.set?.(emoji.id, emoji);
    return emojiData(emoji);
  })();
  pending.set(client, work);
  try { return await work; }
  finally { pending.delete(client); }
}
