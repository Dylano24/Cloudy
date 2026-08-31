import { EmbedBuilder } from 'discord.js';

export const CLOUDY_LOGO_URL =
  'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo-auf-auf.gif?v=desktop-safe-258043242096f2e57923054f6195a067376296aa';

const LEGACY_CLOUDY_LOGO_FILENAMES = new Set([
  'cloudy-c-logo.png',
  'cloudy-c-footer.png',
  'cloudy-logo.png',
  'cloudy-ticket-c-layout.png',
  'cloudy-ticket-c-layout.svg',
  'cloudy-ticket-welcome-c.png',
]);

const EMBED_PATCH_SYMBOL = Symbol.for('cloudy.logo.embed-patch.v1');

function cleanUrl(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(String(value)).split('#')[0].split('?')[0].toLowerCase();
  } catch {
    return String(value).split('#')[0].split('?')[0].toLowerCase();
  }
}

function filenameFromUrl(value) {
  const cleaned = cleanUrl(value);
  const parts = cleaned.split('/');
  return parts.at(-1) || '';
}

export function isLegacyCloudyLogoUrl(value) {
  if (!value) return false;
  const filename = filenameFromUrl(value);
  if (filename === filenameFromUrl(CLOUDY_LOGO_URL)) return false;
  if (LEGACY_CLOUDY_LOGO_FILENAMES.has(filename)) return true;

  // Discord preserves old CDN upload names in many different forms. Treat
  // every older Cloudy C-logo asset as legacy while leaving AUF AUF untouched.
  return /^(?:cloudy-c-|cloudy-logo|cloudy-ticket-c-|cloudy-ticket-welcome-c).*\.(?:png|jpe?g|gif|webp|svg)$/i.test(filename);
}

export function isCloudyLogoUrl(value) {
  if (!value) return false;
  return cleanUrl(value) === cleanUrl(CLOUDY_LOGO_URL) || isLegacyCloudyLogoUrl(value);
}

function migrateMediaNode(node) {
  const shouldRefresh = node && typeof node === 'object' && (
    isLegacyCloudyLogoUrl(node.url)
    || (isCloudyLogoUrl(node.url) && node.url !== CLOUDY_LOGO_URL)
  );
  if (!shouldRefresh) {
    return { node, changed: false };
  }
  return { node: { ...node, url: CLOUDY_LOGO_URL }, changed: true };
}

function migrateIconNode(node) {
  if (!node || typeof node !== 'object') return { node, changed: false };
  const iconUrl = node.icon_url || node.iconURL;
  if (!isLegacyCloudyLogoUrl(iconUrl) && !(isCloudyLogoUrl(iconUrl) && iconUrl !== CLOUDY_LOGO_URL)) {
    return { node, changed: false };
  }
  const next = { ...node };
  if ('icon_url' in next || !('iconURL' in next)) next.icon_url = CLOUDY_LOGO_URL;
  if ('iconURL' in next) next.iconURL = CLOUDY_LOGO_URL;
  return { node: next, changed: true };
}

export function migrateCloudyLogoEmbedData(embed) {
  const source = typeof embed?.toJSON === 'function' ? embed.toJSON() : { ...(embed || {}) };
  if (!source || typeof source !== 'object') return { data: source, changed: false };
  const data = { ...source };
  let changed = false;
  const thumbnail = migrateMediaNode(source.thumbnail);
  if (thumbnail.changed) { data.thumbnail = thumbnail.node; changed = true; }
  const image = migrateMediaNode(source.image);
  if (image.changed) { data.image = image.node; changed = true; }
  const author = migrateIconNode(source.author);
  if (author.changed) { data.author = author.node; changed = true; }
  const footer = migrateIconNode(source.footer);
  if (footer.changed) { data.footer = footer.node; changed = true; }
  return { data, changed };
}

export function installCloudyLogoEmbedPatch() {
  const prototype = EmbedBuilder.prototype;
  if (prototype[EMBED_PATCH_SYMBOL]) return false;
  const originalToJSON = prototype.toJSON;
  Object.defineProperty(prototype, EMBED_PATCH_SYMBOL, {
    value: true, configurable: false, enumerable: false, writable: false,
  });
  prototype.toJSON = function cloudyLogoToJSON(...args) {
    const original = originalToJSON.apply(this, args);
    return migrateCloudyLogoEmbedData(original).data;
  };
  return true;
}

export async function normalizeCloudyLogoMessage(message) {
  if (!message?.editable || !message.embeds?.length) return false;
  let changed = false;
  const embeds = message.embeds.map(embed => {
    const migrated = migrateCloudyLogoEmbedData(embed);
    if (!migrated.changed) return embed;
    changed = true;
    return new EmbedBuilder(migrated.data);
  });
  if (!changed) return false;
  const edited = await message.edit({ embeds }).catch(() => null);
  return Boolean(edited);
}
