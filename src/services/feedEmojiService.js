// Custom emojis for the game server boards (owner's choice). They come from a
// server Cloudy is not in, so Cloudy uploads them once as its own application
// emojis (usable everywhere) and uses those. Until then the original markup.
import { logger } from '../utils/logger.js';

const FEED_EMOJIS = Object.freeze({
  online: { name: 'glowing_dot_green', id: '1567760480439771286', fallback: '<a:glowing_dot_green:1567760480439771286>' },
  offline: { name: 'W8733476glowingdotred', id: '1543291468377104436', fallback: '<:W8733476glowingdotred:1543291468377104436>' },
  server: { name: 'server_router', id: '1567766741889585203', fallback: '<a:server_router:1567766741889585203>' },
  headshot: { name: 'headshot', id: '1567810194564583454', fallback: '<:headshot:1567810194564583454>' },
  login: { name: 'login_green_slim', id: '1567839550074519626', fallback: '<:login_green_slim:1567839550074519626>' },
  logout: { name: 'logout_red_slim', id: '1567839550552805436', fallback: '<:logout_red_slim:1567839550552805436>' },
  killer: { name: 'killer', id: '1567842334668886046', fallback: '<:killer:1567842334668886046>' },
  victim: { name: 'victim', id: '1567845116377440396', fallback: '<:victim:1567845116377440396>' },
  xbox: { name: 'whitexboxlogominimal', id: '1567847794968887366', fallback: '<:whitexboxlogominimal:1567847794968887366>' },
  console: { name: 'console', id: '1567848153284214834', fallback: '<:console:1567848153284214834>' },
  distance: { name: 'distance', id: '1567849614969667615', fallback: '<:distance:1567849614969667615>' },
  on: { name: 'on', id: '1567853607867514901', fallback: '<:on:1567853607867514901>' },
  off: { name: 'off', id: '1567853607682973820', fallback: '<:off:1567853607682973820>' },
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
