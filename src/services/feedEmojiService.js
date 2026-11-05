// Custom emojis for the game server boards (owner's choice). They come from a
// server Cloudy is not in, so Cloudy uploads them once as its own application
// emojis (usable everywhere) and uses those. Until then the original markup.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { runLocalCommand } from './cloudyFeedVideoClip.js';

const BASE_EMOJIS = {
  online: { name: 'glowing_dot_green', id: '1567760480439771286', fallback: '<a:glowing_dot_green:1567760480439771286>' },
  offline: { name: 'W8733476glowingdotred', id: '1543291468377104436', fallback: '<:W8733476glowingdotred:1543291468377104436>' },
  dot: { name: 'W87205667glowingdotwhite', id: '1543291335036108830', fallback: '<:W87205667glowingdotwhite:1543291335036108830>' },
  ban: { name: 'ban_hammer', id: '1567882933992300645', fallback: '<a:ban_hammer:1567882933992300645>' },
  unban: { name: 'unban', id: '1567878123259830384', fallback: '<a:unban:1567878123259830384>' },
  server: { name: 'server_router', id: '1567766741889585203', fallback: '<a:server_router:1567766741889585203>' },
  headshot: { name: 'headshot', id: '1567810194564583454', fallback: '<:headshot:1567810194564583454>' },
  login: { name: 'cloudy_arrow_green_v3', crop: '52:72:38:24', id: '1567869645875191871', fallback: '<a:cloudy_arrow_green:1567869645875191871>' },
  logout: { name: 'cloudy_arrow_red_v3', crop: '52:72:38:24', id: '1567869661347840040', fallback: '<a:cloudy_arrow_red:1567869661347840040>' },
  weapon: { name: 'X83rust4ar', id: '1543286149630656592', fallback: '<:X83rust4ar:1543286149630656592>' },
  killer: { name: 'killer_suit', id: '1567873111204958292', fallback: '<:killer_suit:1567873111204958292>' },
  victim: { name: 'victim_suit', id: '1567873113428070411', fallback: '<:victim_suit:1567873113428070411>' },
  xbox: { name: 'xbox_logo_small', shrink: true, id: '1567847794968887366', fallback: '<:whitexboxlogominimal:1567847794968887366>' },
  console: { name: 'console', id: '1567848153284214834', fallback: '<:console:1567848153284214834>' },
  distance: { name: 'distance', id: '1567849614969667615', fallback: '<:distance:1567849614969667615>' },
  on: { name: 'on_swipe', id: '1567862120639635458', fallback: '<a:on_swipe:1567862120639635458>' },
  off: { name: 'off_swipe', id: '1567862121117782077', fallback: '<a:off_swipe:1567862121117782077>' },
};

// Rust weapon emojis (owner's choice): shown after "Weapon:" / "Used:" for the
// weapon in the event. The pictures have a white background, so they are
// uploaded with the white removed. Order matters: the first alias found wins.
const WEAPONS = [
  ['lr300', '1331942337672384584', ['lr300', 'lr']],
  ['mp5', '1331942366021554248', ['mp5']],
  ['thompson', '1331942293523009546', ['thompson', 'tommy']],
  ['smg', '1321084795039518742', ['customsmg', 'smg']],
  ['python', '1334447422167842857', ['python']],
  ['revolver', '1331942315903942718', ['revolver']],
  ['m92', '1331942461894823956', ['m92']],
  ['p250', '1331942389773762623', ['semiautomaticpistol', 'p250', 'sap']],
  ['prototype', '1331942412267814922', ['prototype17', 'prototype', 'p17']],
  ['pump', '1331942484791660545', ['pumpshotgun', 'pump']],
  ['spas', '1331942440009072721', ['spas12', 'spas']],
  ['sar', '1331942247805227130', ['semiautomaticrifle', 'sar']],
  ['bolt', '1331942270705991710', ['boltaction', 'bolt', 'l96']],
  ['m249', '1321080290797424670', ['m249']],
  ['crossbow', '1321084926522687488', ['crossbow']],
  ['rocket', '1321084510661640192', ['rocketlauncher', 'rocket']],
  ['jackhammer', '1321084243560104008', ['jackhammer']],
  ['pickaxe', '1321084422069686302', ['pickaxe']],
  ['axe', '1321084470136279166', ['salvagedaxe', 'axe']],
  ['turret', '1321080979833618503', ['autoturret', 'turret']],
  ['satchel', '1321084554110566570', ['satchel']],
  ['c4', '1255562123027943454', ['c4', 'timedexplosive', 'explosive']],
  ['flamethrower', '1321081135970783345', ['flamethrower', 'flame']],
  ['ak', '1255551553889370154', ['assaultrifle', 'ak47', 'ak']],
];
for (const [key, id, aliases] of WEAPONS) {
  BASE_EMOJIS[`w_${key}`] = { name: `rust_${key}`, unwhite: true, id, aliases, fallback: `<:rust_${key}:${id}>` };
}
// Flashy success-style numbers for the vote buttons (owner's choice). They are
// made in this repo (assets/vote-emojis) and uploaded as application emojis;
// until then the keycap emoji is used.
['1️⃣', '2️⃣', '3️⃣'].forEach((keycap, index) => {
  BASE_EMOJIS[`vote_${index + 1}`] = { name: `vote_${index + 1}_badge`, file: `../../assets/vote-emojis/vote_${index + 1}.gif`, fallback: keycap };
});
const FEED_EMOJIS = Object.freeze(BASE_EMOJIS);
const resolved = new Map();

/** The emoji of the weapon in `text` ("Assault rifle", "AK-47", "Rocket"), or '' when unknown. */
export function weaponEmoji(text) {
  const normalized = String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return '';
  for (const [key, , aliases] of WEAPONS) {
    if (aliases.some(alias => normalized.includes(alias))) return feedEmoji(`w_${key}`);
  }
  return '';
}

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

// The arrows carry a dark copy of themselves behind them. Near-black and dark
// grey pixels are made transparent so only the coloured arrow stays.
const REMOVE_DARK_SHADOW = "format=gbrap,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(max(max(r(X,Y),g(X,Y)),b(X,Y)),56)+lt(max(max(r(X,Y),g(X,Y)),b(X,Y))-min(min(r(X,Y),g(X,Y)),b(X,Y)),24)*lt(max(max(r(X,Y),g(X,Y)),b(X,Y)),90),0,alpha(X,Y))',format=rgba";

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
      '-vf', `${REMOVE_DARK_SHADOW},crop=${crop},scale=128:128:force_original_aspect_ratio=decrease:flags=lanczos,pad=128:128:(ow-iw)/2:(oh-ih)/2:color=black@0,split[a][b];[a]palettegen=reserve_transparent=1:max_colors=64[p];[b][p]paletteuse=alpha_threshold=128:dither=none`,
      '-loop', '0', output,
    ], 60_000);
    const result = await readFile(output);
    // Discord accepts emojis up to 256 KB; keep the original when the copy is bigger.
    return result.length <= 250_000 ? result : buffer;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

// The weapon pictures come on a white square: near-white pixels become transparent.
async function removeWhiteBackground(buffer) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudy-emoji-'));
  try {
    const input = path.join(directory, 'source');
    const output = path.join(directory, 'emoji.png');
    await writeFile(input, buffer);
    await runLocalCommand('ffmpeg', [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', input, '-frames:v', '1', '-vf', 'format=rgba,colorkey=0xFFFFFF:0.14:0.06', output,
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
      if (accessible && !emoji.shrink && !emoji.crop && !emoji.unwhite) { resolved.set(key, markup(accessible)); continue; }
      let own = [...existing.values()].find(item => item.name === emoji.name);
      if (!own) {
        let image = emoji.file
          ? await readFile(new URL(emoji.file, import.meta.url)).catch(() => null)
          : await download(emoji.id);
        if (!image) continue;
        if (emoji.shrink) image = await shrinkEmojiImage(image).catch(() => image);
        if (emoji.crop) image = await cropEmojiImage(image, emoji.crop).catch(() => image);
        if (emoji.unwhite) image = await removeWhiteBackground(image).catch(() => image);
        own = await manager.create({ attachment: image, name: emoji.name });
      }
      resolved.set(key, markup(own));
    }
  } catch (error) {
    logger.warn(`Could not prepare the game server emojis: ${error?.message || error}`);
  }
}
