import { EmbedBuilder } from 'discord.js';

export const CLOUDY_RED_COLOR = 0x7A1712;
export const CLOUDY_GREEN_COLOR = 0x00C49D;
export const CLOUDY_YELLOW_COLOR = 0xFCFFA1;
export const CLOUDY_NEUTRAL_COLOR = 0xFFFFFF;

const LEGACY_SYSTEM_COLOR_MAP = new Map([
  [0x7A1712, CLOUDY_RED_COLOR],
  [0xED4245, CLOUDY_RED_COLOR],
  [0x670102, CLOUDY_RED_COLOR],
  [0xFF0000, CLOUDY_RED_COLOR],

  [0x00C49D, CLOUDY_GREEN_COLOR],
  [0x57F287, CLOUDY_GREEN_COLOR],
  [0x00FF00, CLOUDY_GREEN_COLOR],
  [0x2ECC71, CLOUDY_GREEN_COLOR],

  [0xFCFFA1, CLOUDY_YELLOW_COLOR],
  [0xFEE75C, CLOUDY_YELLOW_COLOR],

  [0xFFFFFF, CLOUDY_NEUTRAL_COLOR],
  [0x5865F2, CLOUDY_NEUTRAL_COLOR],
  [0x3498DB, CLOUDY_NEUTRAL_COLOR],
  [0x336699, CLOUDY_NEUTRAL_COLOR],
  [0x0099FF, CLOUDY_NEUTRAL_COLOR],
]);
const PATCH_MARKER = Symbol.for('cloudy.default-embed-color-policy');
const PRESERVE_NEXT_COLOR = Symbol('cloudy.preserve-next-embed-color');

function colorNumber(value) {
  if (Number.isInteger(value)) return value & 0xFFFFFF;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized, 16) : null;
}

export function canonicalizeKnownCloudySystemColor(value) {
  const color = colorNumber(value);
  if (color == null) return CLOUDY_NEUTRAL_COLOR;
  return LEGACY_SYSTEM_COLOR_MAP.get(color) ?? color;
}

export function normalizeDefaultEmbedColor(value) {
  const color = colorNumber(value);
  if (color == null) return CLOUDY_NEUTRAL_COLOR;

  const canonical = LEGACY_SYSTEM_COLOR_MAP.get(color);
  if (canonical != null) return canonical;

  const red = (color >> 16) & 0xFF;
  const green = (color >> 8) & 0xFF;
  const blue = color & 0xFF;
  return green >= red * 1.15 && green >= blue * 1.08
    ? CLOUDY_GREEN_COLOR
    : CLOUDY_NEUTRAL_COLOR;
}

// Ticket logs and explicitly user-selected colors bypass the default policy.
export function setPreservedEmbedColor(embed, color) {
  embed[PRESERVE_NEXT_COLOR] = true;
  return embed.setColor(color);
}

export function installDefaultEmbedColorPolicy() {
  if (EmbedBuilder.prototype[PATCH_MARKER]) return;
  const originalSetColor = EmbedBuilder.prototype.setColor;
  Object.defineProperty(EmbedBuilder.prototype, PATCH_MARKER, {
    value: true, enumerable: false, configurable: false, writable: false,
  });
  EmbedBuilder.prototype.setColor = function setCloudyDefaultColor(value) {
    if (this[PRESERVE_NEXT_COLOR]) {
      delete this[PRESERVE_NEXT_COLOR];
      return originalSetColor.call(this, value);
    }
    return originalSetColor.call(this, normalizeDefaultEmbedColor(value));
  };
}
