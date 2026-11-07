import { readFile } from 'node:fs/promises';

export const SUPPORT_BOT_EMOJI_NAME = 'cloudy_support_bot_white';
const pending = new WeakMap();

function findEmoji(collection) {
  return [...(collection?.values?.() || [])].find(emoji => emoji.name === SUPPORT_BOT_EMOJI_NAME);
}

export function supportBotEmoji(client) {
  const emoji = findEmoji(client?.application?.emojis?.cache);
  return emoji ? {id: emoji.id, name: emoji.name, animated: Boolean(emoji.animated)} : {name: '🤖'};
}

export async function ensureSupportBotEmoji(client) {
  if (supportBotEmoji(client).id) return supportBotEmoji(client);
  if (pending.has(client)) return pending.get(client);
  const work = (async () => {
    const manager = client?.application?.emojis;
    if (!manager?.fetch || !manager?.create) throw new Error('Application emoji access is unavailable');
    const existing = await manager.fetch();
    const emoji = findEmoji(existing) || await manager.create({name: SUPPORT_BOT_EMOJI_NAME,
      attachment: await readFile(new URL('../../assets/support-bot-white.png', import.meta.url))});
    manager.cache?.set(emoji.id, emoji);
    return {id: emoji.id, name: emoji.name, animated: Boolean(emoji.animated)};
  })();
  pending.set(client, work);
  try { return await work; }
  finally { pending.delete(client); }
}
