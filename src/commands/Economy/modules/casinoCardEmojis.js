import { deflateSync } from 'node:zlib';

const CARD_SIZE = 64;
const FACE_W = 34;
const FACE_H = 48;
const FACE_X = Math.floor((CARD_SIZE - FACE_W) / 2);
const FACE_Y = Math.floor((CARD_SIZE - FACE_H) / 2);
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
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function surface(width, height) {
  const pixels = Buffer.alloc(width * height * 4, 0);
  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; pixels[i + 3] = color[3] ?? 255;
  };
  const rect = (x, y, w, h, color) => {
    for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) set(xx, yy, color);
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

function circle(s, cx, cy, radius, color) {
  for (let y = -radius; y <= radius; y += 1) for (let x = -radius; x <= radius; x += 1) if (x*x + y*y <= radius*radius) s.set(cx+x, cy+y, color);
}

function triangle(s, ax, ay, bx, by, cx, cy, color) {
  const minX = Math.floor(Math.min(ax,bx,cx)), maxX = Math.ceil(Math.max(ax,bx,cx));
  const minY = Math.floor(Math.min(ay,by,cy)), maxY = Math.ceil(Math.max(ay,by,cy));
  const area = (x1,y1,x2,y2,x3,y3) => x1*(y2-y3)+x2*(y3-y1)+x3*(y1-y2);
  const full = area(ax,ay,bx,by,cx,cy);
  for (let y=minY;y<=maxY;y+=1) for (let x=minX;x<=maxX;x+=1) {
    const a=area(x,y,bx,by,cx,cy)/full, b=area(ax,ay,x,y,cx,cy)/full, c=1-a-b;
    if (a>=0&&b>=0&&c>=0) s.set(x,y,color);
  }
}

function suitKind(suit = '') {
  if (suit === '♥') return 'heart';
  if (suit === '♦') return 'diamond';
  if (suit === '♣') return 'club';
  return 'spade';
}

function drawSuit(s, suit, cx, cy, size, color) {
  const kind = suitKind(suit);
  if (kind === 'diamond') {
    triangle(s,cx,cy-size,cx+size,cy,cx,cy+size,color); triangle(s,cx,cy-size,cx-size,cy,cx,cy+size,color); return;
  }
  if (kind === 'heart') {
    circle(s,cx-Math.floor(size/2),cy-Math.floor(size/3),Math.max(1,Math.floor(size/2)),color);
    circle(s,cx+Math.floor(size/2),cy-Math.floor(size/3),Math.max(1,Math.floor(size/2)),color);
    triangle(s,cx-size,cy-Math.floor(size/3),cx+size,cy-Math.floor(size/3),cx,cy+size,color); return;
  }
  if (kind === 'club') {
    circle(s,cx,cy-Math.floor(size/2),Math.max(1,Math.floor(size/2)),color);
    circle(s,cx-Math.floor(size/2),cy,Math.max(1,Math.floor(size/2)),color);
    circle(s,cx+Math.floor(size/2),cy,Math.max(1,Math.floor(size/2)),color);
    s.rect(cx-1,cy,3,size,color); return;
  }
  triangle(s,cx-size,cy+Math.floor(size/3),cx+size,cy+Math.floor(size/3),cx,cy-size,color);
  circle(s,cx-Math.floor(size/2),cy+Math.floor(size/4),Math.max(1,Math.floor(size/2)),color);
  circle(s,cx+Math.floor(size/2),cy+Math.floor(size/4),Math.max(1,Math.floor(size/2)),color);
  s.rect(cx-1,cy+Math.floor(size/4),3,Math.max(2,size),color);
}

function glyph(s, char, x, y, scale, color) {
  const rows = FONT[char];
  if (!rows) return;
  rows.forEach((row, yy) => [...row].forEach((bit, xx) => { if (bit === '1') s.rect(x + xx*scale, y + yy*scale, scale, scale, color); }));
}

function rank(s, value, x, y, scale, color) {
  let cursor = x;
  for (const char of String(value)) { glyph(s,char,cursor,y,scale,color); cursor += 6*scale; }
}

function png(s) {
  const stride = s.width * 4;
  const raw = Buffer.alloc((stride + 1) * s.height);
  for (let y=0;y<s.height;y+=1) {
    raw[y*(stride+1)] = 0;
    s.pixels.copy(raw,y*(stride+1)+1,y*stride,(y+1)*stride);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(s.width,0); ihdr.writeUInt32BE(s.height,4); ihdr[8]=8; ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}

function render(card, hidden = false) {
  const s = surface(CARD_SIZE,CARD_SIZE);
  const border = [205,205,205,255];
  const white = [255,255,255,255];
  roundedRect(s,FACE_X,FACE_Y,FACE_W,FACE_H,3,border);
  roundedRect(s,FACE_X+1,FACE_Y+1,FACE_W-2,FACE_H-2,2,white);

  if (hidden) {
    roundedRect(s,FACE_X+3,FACE_Y+3,FACE_W-6,FACE_H-6,1,[35,43,53,255]);
    for (let y=FACE_Y+6;y<FACE_Y+FACE_H-5;y+=6) for (let x=FACE_X+6;x<FACE_X+FACE_W-5;x+=6) {
      if (((x+y)/6)%2 < 1) s.rect(x,y,2,2,[205,209,214,255]);
    }
    return png(s);
  }

  const red = suitKind(card.suit) === 'heart' || suitKind(card.suit) === 'diamond';
  const color = red ? [214,57,63,255] : [33,34,38,255];
  rank(s,card.rank,FACE_X+4,FACE_Y+4,1,color);
  drawSuit(s,card.suit,FACE_X+7,FACE_Y+17,3,color);
  drawSuit(s,card.suit,FACE_X+Math.floor(FACE_W/2),FACE_Y+Math.floor(FACE_H/2)+7,5,color);
  return png(s);
}

function cardName(card, hidden = false) {
  if (hidden) return 'card_back';
  const suit = { '♠':'s','♥':'h','♦':'d','♣':'c' }[card.suit] || 's';
  return `card_${String(card.rank).toLowerCase()}${suit}`;
}

async function emojiManager(client) {
  if (!client.application?.emojis) return null;
  let state = cache.get(client);
  if (!state) {
    state = { loaded: false, byName: new Map() };
    cache.set(client,state);
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
  const name = cardName(card,hidden);
  const state = await emojiManager(client);
  if (!state) return hidden ? '🂠' : `${card.rank}${card.suit}`;
  let emoji = state.byName.get(name);
  if (!emoji) {
    try {
      emoji = await client.application.emojis.create({ attachment: render(card,hidden), name });
      state.byName.set(name,emoji);
    } catch {
      return hidden ? '🂠' : `${card.rank}${card.suit}`;
    }
  }
  return emoji.toString();
}

export async function cardsEmojiLine(client, cards = []) {
  const rendered = await Promise.all(cards.map(card => cardEmoji(client,card,false)));
  return rendered.join(' ');
}
