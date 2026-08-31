import { deflateSync } from 'node:zlib';

// Discord renders custom emojis at a fixed inline height, so the card fills almost
// the complete 128x128 source image. This makes it visibly larger than the native
// Unicode playing-card glyphs while keeping the UnbelievaBoat-style inline layout.
const CARD_SIZE = 128;
const FACE_W = 86;
const FACE_H = 120;
const FACE_X = Math.floor((CARD_SIZE - FACE_W) / 2);
const FACE_Y = Math.floor((CARD_SIZE - FACE_H) / 2);
const VERSION = 'v2';
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

const PIP_LAYOUTS = {
  '2': [[0.5,0.25],[0.5,0.75]],
  '3': [[0.5,0.22],[0.5,0.5],[0.5,0.78]],
  '4': [[0.32,0.28],[0.68,0.28],[0.32,0.72],[0.68,0.72]],
  '5': [[0.32,0.25],[0.68,0.25],[0.5,0.5],[0.32,0.75],[0.68,0.75]],
  '6': [[0.32,0.22],[0.68,0.22],[0.32,0.5],[0.68,0.5],[0.32,0.78],[0.68,0.78]],
  '7': [[0.32,0.20],[0.68,0.20],[0.5,0.36],[0.32,0.5],[0.68,0.5],[0.32,0.80],[0.68,0.80]],
  '8': [[0.32,0.19],[0.68,0.19],[0.5,0.34],[0.32,0.5],[0.68,0.5],[0.5,0.66],[0.32,0.81],[0.68,0.81]],
  '9': [[0.32,0.18],[0.68,0.18],[0.32,0.36],[0.68,0.36],[0.5,0.5],[0.32,0.64],[0.68,0.64],[0.32,0.82],[0.68,0.82]],
  '10': [[0.32,0.16],[0.68,0.16],[0.5,0.29],[0.32,0.37],[0.68,0.37],[0.32,0.63],[0.68,0.63],[0.5,0.71],[0.32,0.84],[0.68,0.84]],
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
    const i = (Math.round(y) * width + Math.round(x)) * 4;
    pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; pixels[i + 3] = color[3] ?? 255;
  };
  const rect = (x, y, w, h, color) => {
    for (let yy = Math.round(y); yy < Math.round(y + h); yy += 1) for (let xx = Math.round(x); xx < Math.round(x + w); xx += 1) set(xx, yy, color);
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
    s.rect(cx-Math.max(1,Math.floor(size/5)),cy,Math.max(2,Math.floor(size*0.4)),size,color); return;
  }
  triangle(s,cx-size,cy+Math.floor(size/3),cx+size,cy+Math.floor(size/3),cx,cy-size,color);
  circle(s,cx-Math.floor(size/2),cy+Math.floor(size/4),Math.max(1,Math.floor(size/2)),color);
  circle(s,cx+Math.floor(size/2),cy+Math.floor(size/4),Math.max(1,Math.floor(size/2)),color);
  s.rect(cx-Math.max(1,Math.floor(size/5)),cy+Math.floor(size/4),Math.max(2,Math.floor(size*0.4)),Math.max(2,size),color);
}

function glyph(s, char, x, y, scale, color) {
  const rows = FONT[char]; if (!rows) return;
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

function drawIndex(s, card, color) {
  const scale = card.rank === '10' ? 2 : 3;
  rank(s, card.rank, FACE_X + 7, FACE_Y + 7, scale, color);
  const suitY = FACE_Y + (card.rank === '10' ? 31 : 34);
  drawSuit(s, card.suit, FACE_X + 14, suitY, 6, color);
}

function drawNumberCard(s, card, color) {
  if (card.rank === 'A') {
    drawSuit(s, card.suit, FACE_X + FACE_W/2, FACE_Y + FACE_H/2 + 6, 20, color);
    return;
  }
  const layout = PIP_LAYOUTS[card.rank] || [];
  for (const [x,y] of layout) drawSuit(s, card.suit, FACE_X + Math.round(FACE_W*x), FACE_Y + Math.round(FACE_H*y), 7, color);
}

function drawCourtCard(s, card, color) {
  const x = FACE_X + 22, y = FACE_Y + 25, w = FACE_W - 29, h = FACE_H - 34;
  roundedRect(s,x,y,w,h,4,[244,236,211,255]);
  s.rect(x+3,y+3,w-6,4,[32,72,122,255]);
  s.rect(x+3,y+h-7,w-6,4,[32,72,122,255]);
  s.rect(x+3,y+Math.floor(h/2)-2,w-6,4,[202,45,52,255]);
  circle(s,x+Math.floor(w/2),y+22,10,[239,199,146,255]);
  s.rect(x+Math.floor(w/2)-10,y+13,20,5,[62,44,32,255]);
  triangle(s,x+7,y+38,x+w-7,y+38,x+Math.floor(w/2),y+62,[42,87,150,255]);
  triangle(s,x+7,y+h-38,x+w-7,y+h-38,x+Math.floor(w/2),y+h-62,[202,45,52,255]);
  rank(s,card.rank,x+Math.floor(w/2)-8,y+Math.floor(h/2)-10,3,color);
  drawSuit(s,card.suit,x+Math.floor(w/2),y+Math.floor(h/2)+18,7,color);
}

function render(card, hidden = false) {
  const s = surface(CARD_SIZE,CARD_SIZE);
  const shadow = [0,0,0,45];
  const border = [190,194,202,255];
  const white = [255,255,255,255];

  roundedRect(s,FACE_X+2,FACE_Y+2,FACE_W,FACE_H,8,shadow);
  roundedRect(s,FACE_X,FACE_Y,FACE_W,FACE_H,8,border);
  roundedRect(s,FACE_X+2,FACE_Y+2,FACE_W-4,FACE_H-4,7,white);

  if (hidden) {
    roundedRect(s,FACE_X+6,FACE_Y+6,FACE_W-12,FACE_H-12,5,[40,73,118,255]);
    roundedRect(s,FACE_X+10,FACE_Y+10,FACE_W-20,FACE_H-20,3,[235,239,247,255]);
    roundedRect(s,FACE_X+13,FACE_Y+13,FACE_W-26,FACE_H-26,2,[40,73,118,255]);
    for (let y=FACE_Y+18;y<FACE_Y+FACE_H-16;y+=9) for (let x=FACE_X+18;x<FACE_X+FACE_W-16;x+=9) {
      const alternate = ((x+y)/9) % 2 < 1;
      drawSuit(s, alternate ? '♦' : '♣', x, y, 2, [223,231,243,255]);
    }
    return png(s);
  }

  const red = suitKind(card.suit) === 'heart' || suitKind(card.suit) === 'diamond';
  const color = red ? [197,31,45,255] : [24,26,30,255];
  drawIndex(s,card,color);

  if (['J','Q','K'].includes(card.rank)) drawCourtCard(s,card,color);
  else drawNumberCard(s,card,color);

  return png(s);
}

function cardName(card, hidden = false) {
  if (hidden) return `${VERSION}_card_back`;
  const suit = { '♠':'s','♥':'h','♦':'d','♣':'c' }[card.suit] || 's';
  return `${VERSION}_card_${String(card.rank).toLowerCase()}${suit}`;
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
