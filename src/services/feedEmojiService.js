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
  // New versioned names force a one-time reupload: older report dots were
  // large glossy orbs, unlike Cloudy's small green/red neon status lights.
  report_blue: { name: 'cloudy_report_dot_blue_v2', file: '../../assets/feed-emojis/report_dot_blue.png', fallback: '🔵' },
  report_orange: { name: 'cloudy_report_dot_orange_v2', file: '../../assets/feed-emojis/report_dot_orange.png', fallback: '🟠' },
  ban: { name: 'ban', id: '1567878137059082414', fallback: '<a:ban:1567878137059082414>' },
  kit: { name: 'cloudy_kit', id: '1568298883682009109', fallback: '<a:cloudy_kit:1568298883682009109>' },
  unban: { name: 'unban', id: '1567878123259830384', fallback: '<a:unban:1567878123259830384>' },
  // Server icon (owner's choice): the owner's own cloudy_hosting_server_small;
// its picture is kept in assets so Cloudy can always upload it.
  server: { name: 'cloudy_hosting_server_small', id: '1568468995747881030', file: '../../assets/feed-emojis/cloudy_hosting_server_small.gif', fallback: '<a:cloudy_hosting_server_small:1568468995747881030>' },
  headshot: { name: 'headshot', id: '1567810194564583454', fallback: '<:headshot:1567810194564583454>' },
  // Login and Logout (owner's choice): the owner's own on and off emoji, found
  // among the application's emojis by name (the id is not needed), whichever
  // name it has now. Until it is found the old arrows are shown.
  login: { name: 'cloudy_on', id: '1568309193180581963', fallbackKey: 'login_arrow', fallback: '<a:cloudy_on:1568309193180581963>' },
  logout: { name: 'cloudy_off', id: '1568309283261653033', fallbackKey: 'logout_arrow', fallback: '<a:cloudy_off:1568309283261653033>' },
  login_arrow: { name: 'cloudy_arrow_green_v3', crop: '52:72:38:24', id: '1567869645875191871', fallback: '<a:cloudy_arrow_green:1567869645875191871>' },
  logout_arrow: { name: 'cloudy_arrow_red_v3', crop: '52:72:38:24', id: '1567869661347840040', fallback: '<a:cloudy_arrow_red:1567869661347840040>' },
  weapon: { name: 'X83rust4ar', id: '1543286149630656592', fallback: '<:X83rust4ar:1543286149630656592>' },
  killer: { name: 'killer_suit', id: '1567873111204958292', fallback: '<:killer_suit:1567873111204958292>' },
  victim: { name: 'victim_suit', id: '1567873113428070411', fallback: '<:victim_suit:1567873113428070411>' },
  xbox: { name: 'xbox_logo_small', shrink: true, id: '1567847794968887366', fallback: '<:whitexboxlogominimal:1567847794968887366>' },
  console: { name: 'console', id: '1567848153284214834', fallback: '<:console:1567848153284214834>' },
  distance: { name: 'distance', id: '1567849614969667615', fallback: '<:distance:1567849614969667615>' },
  // Player killed (owner's choice): the owner's own animated icons, one in front
  // of the killer, victim, weapon and headshot lines.
  kill_killer: { name: 'cloudy_killer', id: '1568299238646091907', fallback: '<a:cloudy_killer:1568299238646091907>' },
  kill_victim: { name: 'cloudy_victim', id: '1568299277766238273', fallback: '<a:cloudy_victim:1568299277766238273>' },
  kill_weapon: { name: 'cloudy_rifle', id: '1568299289984106526', fallback: '<a:cloudy_rifle:1568299289984106526>' },
  kill_skull: { name: 'cloudy_headshot', id: '1568299328450207764', fallback: '<a:cloudy_headshot:1568299328450207764>' },
  // ZORP on/off (owner's choice): the owner's own cloudy_zorp_on / cloudy_zorp_off.
  on: { name: 'cloudy_zorp_on', id: '1568458840775729264', fallbackKey: 'on_swipe', fallback: '<a:cloudy_zorp_on:1568458840775729264>' },
  off: { name: 'cloudy_zorp_off', id: '1568458812761833632', fallbackKey: 'off_swipe', fallback: '<a:cloudy_zorp_off:1568458812761833632>' },
  // Raid alert (owner's choice): the owner's own cloudy_alert.
  raid: { name: 'cloudy_alert', id: '1568465464181653594', fallback: '<a:cloudy_alert:1568465464181653594>' },
  on_swipe: { name: 'on_swipe', id: '1567862120639635458', fallback: '<a:on_swipe:1567862120639635458>' },
  off_swipe: { name: 'off_swipe', id: '1567862121117782077', fallback: '<a:off_swipe:1567862121117782077>' },
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
// Vote emojis (owner's choice), made in this repo (assets/vote-emojis) and
// uploaded as application emojis: white serif digits 1 to 10 in the style of
// the Cloudy logo, the white progress bar pieces and the ballot icon. Until
// they are uploaded the plain fallback is shown.
['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'].forEach((keycap, index) => {
  // Animated white number badges with a glossy light sweep (owner's choice).
  BASE_EMOJIS[`vote_${index + 1}`] = { name: `vote_${index + 1}_shine`, file: `../../assets/vote-emojis/key_${index + 1}.gif`, fallback: keycap };
  // The same badge standing still, for the vote buttons: Discord's app sometimes
  // left an animated emoji in a button empty until the vote was redrawn.
  BASE_EMOJIS[`vote_${index + 1}_still`] = { name: `vote_${index + 1}_still`, file: `../../assets/vote-emojis/key_${index + 1}_still.png`, fallback: keycap };
});
for (const piece of ['lf', 'mf', 'rf', 'le', 'me', 're']) {
  // Filled pieces are white (owner's choice, were green); open pieces grey.
  const filled = piece.endsWith('f');
  BASE_EMOJIS[`bar_${piece}`] = {
    name: filled ? `vb_${piece[0]}w` : `vb_${piece}`,
    file: `../../assets/vote-emojis/bar_${filled ? `${piece[0]}w` : piece}.png`,
    fallback: filled ? '▰' : '▱',
  };
}
BASE_EMOJIS.vote_icon = { name: 'vote_ballot', file: '../../assets/vote-emojis/vote_icon.gif', fallback: '🗳️' };
// Ban log icons (owner's choice): the owner's own emojis (link, Rust gamertag,
// reason; a green reason for an unban) and the server icon, all trimmed and
// scaled to the same size in assets/feed-emojis so they look equally big.
for (const [key, file, fallback] of [
  ['ban_rust', 'ban_rust.gif', '<a:log_rust:1567920463206678639>'],
  ['ban_reason', 'ban_reason.gif', '<a:log_reason:1567920506928111739>'],
  ['ban_reason_green', 'ban_reason_green.gif', '<a:log_reason:1567920506928111739>'],
]) {
  BASE_EMOJIS[key] = { name: key, file: `../../assets/feed-emojis/${file}`, fallback };
}
// The server icon in the ban log is the same emoji (owner's choice).
BASE_EMOJIS.ban_server = { ...BASE_EMOJIS.server };
// The link icon is the owner's own animated `cloudy_link` (owner's choice).
BASE_EMOJIS.ban_link = { name: 'cloudy_link', id: '1568299107930341608', fallback: '<a:cloudy_link:1568299107930341608>' };
// The reason signs a little smaller (owner's choice): the same picture with
// more empty room around it, uploaded under a new name.
BASE_EMOJIS.ban_reason = { ...BASE_EMOJIS.ban_reason, name: 'ban_reason_small', file: '../../assets/feed-emojis/ban_reason_small.gif' };
BASE_EMOJIS.ban_reason_green = { ...BASE_EMOJIS.ban_reason_green, name: 'ban_reason_green_small', file: '../../assets/feed-emojis/ban_reason_green_small.gif' };
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
  const emoji = FEED_EMOJIS[key];
  return resolved.get(key) || emoji?.fallback || (emoji?.fallbackKey ? feedEmoji(emoji.fallbackKey) : '') || '';
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
  let existing;
  try {
    existing = await manager.fetch();
  } catch (error) {
    logger.warn(`Could not prepare the game server emojis: ${error?.message || error}`);
    return;
  }
  // One emoji that fails never stops the others; the result is logged once.
  const created = [];
  const failed = [];
  const missing = [];
  for (const [key, emoji] of Object.entries(FEED_EMOJIS)) {
    try {
      const accessible = client.emojis?.cache?.get?.(emoji.id);
      if (accessible && !emoji.shrink && !emoji.crop && !emoji.unwhite) { resolved.set(key, markup(accessible)); continue; }
      const names = [emoji.name, ...(emoji.alsoNamed || [])];
      let own = [...existing.values()].find(item => names.includes(item.name));
      // An emoji known only by name may also live in a server Cloudy is in.
      if (!own && emoji.byNameOnly) own = [...(client.emojis?.cache?.values?.() || [])].find(item => names.includes(item.name));
      if (!own && emoji.byNameOnly) { missing.push(emoji.name); continue; }
      if (!own) {
        let image = emoji.file
          ? await readFile(new URL(emoji.file, import.meta.url)).catch(() => null)
          : await download(emoji.id);
        if (!image) { failed.push(`${emoji.name} (no picture)`); continue; }
        if (emoji.shrink) image = await shrinkEmojiImage(image).catch(() => image);
        if (emoji.crop) image = await cropEmojiImage(image, emoji.crop).catch(() => image);
        if (emoji.unwhite) image = await removeWhiteBackground(image).catch(() => image);
        own = await manager.create({ attachment: image, name: emoji.name });
        // Another key with the same emoji (the ban log's server icon) reuses it
        // instead of uploading it a second time, which Discord refuses.
        existing.set(own.id, own);
        created.push(emoji.name);
      }
      resolved.set(key, markup(own));
    } catch (error) {
      failed.push(`${emoji.name} (${error?.message || error})`);
    }
  }
  const summary = `[FEED_EMOJIS] ${resolved.size}/${Object.keys(FEED_EMOJIS).length} ready`
    + (created.length ? `; uploaded ${created.join(', ')}` : '')
    + (missing.length ? `; not found by name ${missing.join(', ')}` : '')
    + (failed.length ? `; failed ${failed.join('; ')}` : '');
  if (failed.length) logger.warn(summary);
  else logger.info(summary);
}
