import { deflateSync } from 'node:zlib';

const SIZE = 256;
const TILE = 244;
const OFFSET = Math.floor((SIZE - TILE) / 2);
const VERSION = 'v1';
const cache = new WeakMap();

const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18,
  19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

const FONT = {
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['11110','00001','00001','01110','10000','10000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['10010','10010','10010','11111','00010','00010','00010'],
  '5': ['11111','10000','10000','11110','00001','00001','11110'],
  '6': ['01111','10000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00001','11110'],
};

export function getRouletteColor(number) {
  if (number === 0) return 'green';
  return RED_NUMBERS.has(number) ? 'red' : 'black';
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function surface(width, height) {
  const pixels = Buffer.alloc(width * height * 4, 0);
  const set = (x, y, color) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = (y * width + x) * 4;
    pixels[index] = color[0];
    pixels[index + 1] = color[1];
    pixels[index + 2] = color[2];
    pixels[index + 3] = color[3] ?? 255;
  };
  const rect = (x, y, w, h, color) => {
    for (let yy = Math.round(y); yy < Math.round(y + h); yy += 1) {
      for (let xx = Math.round(x); xx < Math.round(x + w); xx += 1) set(xx, yy, color);
    }
  };
  return { width, height, pixels, set, rect };
}

function roundedRect(s, x, y, w, h, radius, color) {
  for (let yy = 0; yy < h; yy += 1) {
    for (let xx = 0; xx < w; xx += 1) {
      const dx = Math.max(radius - xx, 0, xx - (w - 1 - radius));
      const dy = Math.max(radius - yy, 0, yy - (h - 1 - radius));
      if (dx * dx + dy * dy <= radius * radius) s.set(x + xx, y + yy, color);
    }
  }
}

function glyph(s, char, x, y, scale, color) {
  const rows = FONT[char];
  if (!rows) return;
  rows.forEach((row, yy) => [...row].forEach((bit, xx) => {
    if (bit === '1') s.rect(x + xx * scale, y + yy * scale, scale, scale, color);
  }));
}

function drawNumber(s, number, color) {
  const text = String(number);
  const scale = text.length === 1 ? 26 : 21;
  const width = (text.length * 6 - 1) * scale;
  const height = 7 * scale;
  let x = Math.floor((SIZE - width) / 2);
  const y = Math.floor((SIZE - height) / 2);
  for (const char of text) {
    glyph(s, char, x, y, scale, color);
    x += 6 * scale;
  }
}

function toPng(s) {
  const stride = s.width * 4;
  const raw = Buffer.alloc((stride + 1) * s.height);
  for (let y = 0; y < s.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    s.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s.width, 0);
  ihdr.writeUInt32BE(s.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function render(number) {
  const s = surface(SIZE, SIZE);
  const rouletteColor = getRouletteColor(number);
  const fill = rouletteColor === 'red'
    ? [218, 48, 56, 255]
    : rouletteColor === 'green'
      ? [35, 151, 84, 255]
      : [22, 23, 26, 255];

  roundedRect(s, OFFSET + 2, OFFSET + 3, TILE, TILE, 34, [0, 0, 0, 60]);
  roundedRect(s, OFFSET, OFFSET, TILE, TILE, 34, [255, 255, 255, 255]);
  roundedRect(s, OFFSET + 5, OFFSET + 5, TILE - 10, TILE - 10, 29, fill);
  drawNumber(s, number, [255, 255, 255, 255]);
  return toPng(s);
}

function emojiName(number) {
  return `${VERSION}_roulette_${getRouletteColor(number)}_${number}`;
}

async function getState(client) {
  if (!client.application?.emojis) return null;
  let state = cache.get(client);
  if (!state) {
    state = { byName: new Map(), loadPromise: null, pending: new Map() };
    cache.set(client, state);
  }
  if (!state.loadPromise) {
    state.loadPromise = client.application.emojis.fetch()
      .then(emojis => {
        for (const emoji of emojis.values()) state.byName.set(emoji.name, emoji);
      })
      .catch(() => {});
  }
  await state.loadPromise;
  return state;
}

export async function rouletteNumberEmoji(client, number) {
  const safeNumber = Number(number);
  if (!Number.isInteger(safeNumber) || safeNumber < 0 || safeNumber > 36) return `**${number}**`;

  const name = emojiName(safeNumber);
  const state = await getState(client);
  if (!state) return `**${safeNumber}**`;

  const existing = state.byName.get(name);
  if (existing) return existing.toString();

  if (!state.pending.has(name)) {
    state.pending.set(name, client.application.emojis.create({
      attachment: render(safeNumber),
      name,
    }).then(emoji => {
      state.byName.set(name, emoji);
      return emoji;
    }).finally(() => state.pending.delete(name)));
  }

  try {
    return (await state.pending.get(name)).toString();
  } catch {
    return `**${safeNumber}**`;
  }
}
