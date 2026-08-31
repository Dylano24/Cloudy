import { deflateSync } from 'node:zlib';

// Simple UnbelievaBoat-style inline playing cards: narrow white rectangle,
// large rank at the top and one clear suit underneath. No extra artwork.
const SIZE = 128;
const W = 54;
const H = 92;
const X = Math.floor((SIZE - W) / 2);
const Y = Math.floor((SIZE - H) / 2);
const VERSION = 'v4';
const cache = new WeakMap();

const FONT = {
  A:['01110','10001','10001','11111','10001','10001','10001'],
  '1':['00100','01100','00100','00100','00100','00100','01110'],
  '2':['11110','00001','00001','01110','10000','10000','11111'],
  '3':['11110','00001','00001','01110','00001','00001','11110'],
  '4':['10010','10010','10010','11111','00010','00010','00010'],
  '5':['11111','10000','10000','11110','00001','00001','11110'],
  '6':['01111','10000','10000','11110','10001','10001','01110'],
  '7':['11111','00001','00010','00100','01000','01000','01000'],
  '8':['01110','10001','10001','01110','10001','10001','01110'],
  '9':['01110','10001','10001','01111','00001','00001','11110'],
  '0':['01110','10001','10011','10101','11001','10001','01110'],
  J:['00111','00010','00010','00010','10010','10010','01100'],
  Q:['01110','10001','10001','10001','10101','10010','01101'],
  K:['10001','10010','10100','11000','10100','10010','10001'],
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
}

function makeSurface(width, height) {
  const pixels = Buffer.alloc(width * height * 4, 0);
  const set = (x, y, color) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; pixels[i + 3] = color[3] ?? 255;
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

function circle(s, cx, cy, r, color) {
  for (let y = -r; y <= r; y += 1) {
    for (let x = -r; x <= r; x += 1) {
      if (x * x + y * y <= r * r) s.set(cx + x, cy + y, color);
    }
  }
}

function triangle(s, ax, ay, bx, by, cx, cy, color) {
  const minX = Math.floor(Math.min(ax, bx, cx));
  const maxX = Math.ceil(Math.max(ax, bx, cx));
  const minY = Math.floor(Math.min(ay, by, cy));
  const maxY = Math.ceil(Math.max(ay, by, cy));
  const area = (x1, y1, x2, y2, x3, y3) => x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2);
  const full = area(ax, ay, bx, by, cx, cy);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const a = area(x, y, bx, by, cx, cy) / full;
      const b = area(ax, ay, x, y, cx, cy) / full;
      const c = 1 - a - b;
      if (a >= 0 && b >= 0 && c >= 0) s.set(x, y, color);
    }
  }
}

function kind(suit = '') {
  if (suit === '♥') return 'heart';
  if (suit === '♦') return 'diamond';
  if (suit === '♣') return 'club';
  return 'spade';
}

function drawSuit(s, symbol, cx, cy, size, color) {
  const k = kind(symbol);
  if (k === 'diamond') {
    triangle(s, cx, cy - size, cx + size, cy, cx, cy + size, color);
    triangle(s, cx, cy - size, cx - size, cy, cx, cy + size, color);
    return;
  }
  if (k === 'heart') {
    circle(s, cx - Math.floor(size / 2), cy - Math.floor(size / 3), Math.max(1, Math.floor(size / 2)), color);
    circle(s, cx + Math.floor(size / 2), cy - Math.floor(size / 3), Math.max(1, Math.floor(size / 2)), color);
    triangle(s, cx - size, cy - Math.floor(size / 3), cx + size, cy - Math.floor(size / 3), cx, cy + size, color);
    return;
  }
  if (k === 'club') {
    circle(s, cx, cy - Math.floor(size / 2), Math.max(1, Math.floor(size / 2)), color);
    circle(s, cx - Math.floor(size / 2), cy, Math.max(1, Math.floor(size / 2)), color);
    circle(s, cx + Math.floor(size / 2), cy, Math.max(1, Math.floor(size / 2)), color);
    s.rect(cx - 2, cy, 4, size + 3, color);
    return;
  }
  triangle(s, cx - size, cy + Math.floor(size / 3), cx + size, cy + Math.floor(size / 3), cx, cy - size, color);
  circle(s, cx - Math.floor(size / 2), cy + Math.floor(size / 4), Math.max(1, Math.floor(size / 2)), color);
  circle(s, cx + Math.floor(size / 2), cy + Math.floor(size / 4), Math.max(1, Math.floor(size / 2)), color);
  s.rect(cx - 2, cy + Math.floor(size / 4), 4, size, color);
}

function glyph(s, char, x, y, scale, color) {
  const rows = FONT[char];
  if (!rows) return;
  rows.forEach((row, yy) => {
    [...row].forEach((bit, xx) => {
      if (bit === '1') s.rect(x + xx * scale, y + yy * scale, scale, scale, color);
    });
  });
}

function drawRank(s, value, x, y, scale, color) {
  let cx = x;
  for (const char of String(value)) {
    glyph(s, char, cx, y, scale, color);
    cx += 6 * scale;
  }
}

function png(s) {
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
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawFront(s, card, color) {
  const rankScale = card.rank === '10' ? 3 : 4;
  const rankX = X + 6;
  const rankY = Y + 6;
  drawRank(s, card.rank, rankX, rankY, rankScale, color);

  // One large suit directly under the rank, matching the simple reference card.
  drawSuit(s, card.suit, X + Math.floor(W / 2), Y + 59, 12, color);
}

function drawBack(s) {
  roundedRect(s, X + 4, Y + 4, W - 8, H - 8, 3, [52, 92, 170, 255]);
  roundedRect(s, X + 7, Y + 7, W - 14, H - 14, 2, [231, 237, 248, 255]);
  roundedRect(s, X + 10, Y + 10, W - 20, H - 20, 2, [52, 92, 170, 255]);
  for (let yy = Y + 15; yy < Y + H - 14; yy += 8) {
    for (let xx = X + 15; xx < X + W - 14; xx += 8) {
      drawSuit(s, '♦', xx, yy, 2, [222, 231, 245, 255]);
    }
  }
}

function render(card, hidden = false) {
  const s = makeSurface(SIZE, SIZE);
  const border = [190, 193, 199, 255];
  const white = [255, 255, 255, 255];
  const shadow = [0, 0, 0, 35];

  roundedRect(s, X + 2, Y + 2, W, H, 4, shadow);
  roundedRect(s, X, Y, W, H, 4, border);
  roundedRect(s, X + 1, Y + 1, W - 2, H - 2, 3, white);

  if (hidden) {
    drawBack(s);
    return png(s);
  }

  const red = kind(card.suit) === 'heart' || kind(card.suit) === 'diamond';
  const color = red ? [196, 43, 52, 255] : [18, 18, 20, 255];
  drawFront(s, card, color);
  return png(s);
}

function cardName(card, hidden = false) {
  if (hidden) return `${VERSION}_card_back`;
  const suitCode = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' }[card.suit] || 's';
  return `${VERSION}_card_${String(card.rank).toLowerCase()}${suitCode}`;
}

async function stateFor(client) {
  if (!client.application?.emojis) return null;
  let state = cache.get(client);
  if (!state) {
    state = { loaded: false, byName: new Map() };
    cache.set(client, state);
  }
  if (!state.loaded) {
    try {
      const emojis = await client.application.emojis.fetch();
      for (const emoji of emojis.values()) state.byName.set(emoji.name, emoji);
    } catch {}
    state.loaded = true;
  }
  return state;
}

export async function cardEmoji(client, card, hidden = false) {
  const name = cardName(card, hidden);
  const state = await stateFor(client);
  if (!state) return hidden ? '🂠' : `${card.rank}${card.suit}`;

  let emoji = state.byName.get(name);
  if (!emoji) {
    try {
      emoji = await client.application.emojis.create({ attachment: render(card, hidden), name });
      state.byName.set(name, emoji);
    } catch {
      return hidden ? '🂠' : `${card.rank}${card.suit}`;
    }
  }
  return emoji.toString();
}

export async function cardsEmojiLine(client, cards = []) {
  return (await Promise.all(cards.map(card => cardEmoji(client, card, false)))).join(' ');
}
