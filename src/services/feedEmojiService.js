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
  login: { name: 'cloudy_arrow_green_xl', crop: '52:72:38:28', id: '1567869645875191871', fallback: '<a:cloudy_arrow_green:1567869645875191871>' },
  logout: { name: 'cloudy_arrow_red_xl', crop: '52:72:38:28', id: '1567869661347840040', fallback: '<a:cloudy_arrow_red:1567869661347840040>' },
  weapon: { name: 'X83rust4ar', id: '1543286149630656592', fallback: '<:X83rust4ar:1543286149630656592>' },
  killer: { name: 'killer', id: '1567842334668886046', fallback: '<:killer:1567842334668886046>' },
  victim: { name: 'victim', id: '1567845116377440396', fallback: '<:victim:1567845116377440396>' },
  xbox: { name: 'xbox_logo_small', shrink: true, id: '1567847794968887366', fallback: '<:whitexboxlogominimal:1567847794968887366>' },
  console: { name: 'console', id: '1567848153284214834', fallback: '<:console:1567848153284214834>' },
  distance: { name: 'distance', id: '1567849614969667615', fallback: '<:distance:1567849614969667615>' },
  on: { name: 'on_swipe', id: '1567862120639635458', fallback: '<a:on_swipe:1567862120639635458>' },
  off: { name: 'off_swipe', id: '1567862121117782077', fallback: '<a:off_swipe:1567862121117782077>' },
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

// The arrows sit small inside their square. Cropping to the arrow (the box
// covers every animation frame) and scaling it back up makes them larger.
async function cropEmojiImage(buffer, crop) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudy-emoji-'));
  try {
    const input = path.join(directory, 'source');
    const output = path.join(directory, 'emoji.gif');
    await writeFile(input, buffer);
    await runLocalCommand('ffmpeg', [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', input,
      '-vf', `crop=${crop},scale=128:128:force_original_aspect_ratio=decrease:flags=lanczos,pad=128:128:(ow-iw)/2:(oh-ih)/2:color=black@0,split[a][b];[a]palettegen=reserve_transparent=1:max_colors=64[p];[b][p]paletteuse=alpha_threshold=128:dither=none`,
      '-loop', '0', output,
    ], 60_000);
    const result = await readFile(output);
    // Discord accepts emojis up to 256 KB; keep the original when the copy is bigger.
    return result.length <= 250_000 ? result : buffer;
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
      if (accessible && !emoji.shrink && !emoji.crop) { resolved.set(key, markup(accessible)); continue; }
      let own = [...existing.values()].find(item => item.name === emoji.name);
      if (!own) {
        let image = await download(emoji.id);
        if (!image) continue;
        if (emoji.shrink) image = await shrinkEmojiImage(image).catch(() => image);
        if (emoji.crop) image = await cropEmojiImage(image, emoji.crop).catch(() => image);
        own = await manager.create({ attachment: image, name: emoji.name });
      }
      resolved.set(key, markup(own));
    }
  } catch (error) {
    logger.warn(`Could not prepare the game server emojis: ${error?.message || error}`);
  }
}
