// Custom emojis for the game server boards (owner's choice). They come from a
// server Cloudy is not in, so Cloudy uploads them once as its own application
// emojis (usable everywhere) and uses those. Until then the original markup.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { runLocalCommand } from './cloudyFeedVideoClip.js';

const FEED_EMOJIS = Object.freeze({
  online: { name: 'glowing_dot_green', id: '1567760480439771286', fallback: '<a:glowing_dot_green:1567760480439771286>' },
  offline: { name: 'W8733476glowingdotred', id: '1543291468377104436', fallback: '<:W8733476glowingdotred:1543291468377104436>' },
  server: { name: 'server_router', id: '1567766741889585203', fallback: '<a:server_router:1567766741889585203>' },
  headshot: { name: 'headshot', id: '1567810194564583454', fallback: '<:headshot:1567810194564583454>' },
  login: { name: 'login_green_slim_2', id: '1567857573405925446', fallback: '<:login_green_slim_2:1567857573405925446>' },
  logout: { name: 'logout_red_slim_2', id: '1567858318251270257', fallback: '<:logout_red_slim_2:1567858318251270257>' },
  weapon: { name: 'X83rust4ar', id: '1543286149630656592', fallback: '<:X83rust4ar:1543286149630656592>' },
  killer: { name: 'killer', id: '1567842334668886046', fallback: '<:killer:1567842334668886046>' },
  victim: { name: 'victim', id: '1567845116377440396', fallback: '<:victim:1567845116377440396>' },
  xbox: { name: 'xbox_logo_small', shrink: true, id: '1567847794968887366', fallback: '<:whitexboxlogominimal:1567847794968887366>' },
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

// A picture that fills its whole square looks bigger than the other emojis:
// the same logo at 70% on a transparent square matches them.
async function shrinkEmojiImage(buffer) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudy-emoji-'));
  try {
    const input = path.join(directory, 'source');
    const output = path.join(directory, 'emoji.png');
    await writeFile(input, buffer);
    await runLocalCommand('ffmpeg', [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', input, '-frames:v', '1',
      '-vf', 'format=rgba,scale=90:90:force_original_aspect_ratio=decrease,pad=128:128:(ow-iw)/2:(oh-ih)/2:color=black@0',
      output,
    ], 30_000);
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

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
      if (accessible && !emoji.shrink) { resolved.set(key, markup(accessible)); continue; }
      let own = [...existing.values()].find(item => item.name === emoji.name);
      if (!own) {
        let image = await download(emoji.id);
        if (!image) continue;
        if (emoji.shrink) image = await shrinkEmojiImage(image).catch(() => image);
        own = await manager.create({ attachment: image, name: emoji.name });
      }
      resolved.set(key, markup(own));
    }
  } catch (error) {
    logger.warn(`Could not prepare the game server emojis: ${error?.message || error}`);
  }
}
