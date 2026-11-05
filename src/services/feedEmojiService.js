// Custom emojis for the game server boards (owner's choice). They come from a
// server Cloudy is not in, so Cloudy uploads them once as its own application
// emojis (usable everywhere) and uses those. Until then the original markup.
import { logger } from '../utils/logger.js';

const FEED_EMOJIS = Object.freeze({
  online: { name: 'glowing_dot_green', id: '1567760480439771286', fallback: '<a:glowing_dot_green:1567760480439771286>' },
  offline: { name: 'W8733476glowingdotred', id: '1543291468377104436', fallback: '<:W8733476glowingdotred:1543291468377104436>' },
  server: { name: 'server_router', id: '1567766741889585203', fallback: '<a:server_router:1567766741889585203>' },
});
const resolved = new Map();

export function feedEmoji(key) {
  return resolved.get(key) || FEED_EMOJIS[key]?.fallback || '';
}

const markup = emoji => `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;

async function download(id) {
  for (const extension of ['gif', 'png']) {
    const response = await fetch(`https://cdn.discordapp.com/emojis/${id}.${extension}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const type = response?.headers?.get('content-type') || '';
    if (response?.ok && type.startsWith('image/')) return Buffer.from(await response.arrayBuffer());
  }
  return null;
}

export async function ensureFeedEmojis(client) {
  const manager = client.application?.emojis;
  if (!manager?.fetch) return;
  try {
    const existing = await manager.fetch();
    for (const [key, emoji] of Object.entries(FEED_EMOJIS)) {
      const accessible = client.emojis?.cache?.get?.(emoji.id);
      if (accessible) { resolved.set(key, markup(accessible)); continue; }
      let own = [...existing.values()].find(item => item.name === emoji.name);
      if (!own) {
        const image = await download(emoji.id);
        if (!image) continue;
        own = await manager.create({ attachment: image, name: emoji.name });
      }
      resolved.set(key, markup(own));
    }
  } catch (error) {
    logger.warn(`Could not prepare the game server emojis: ${error?.message || error}`);
  }
}
