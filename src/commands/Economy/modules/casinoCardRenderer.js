import { deflateSync } from 'node:zlib';

const FONT = {
  A:['01110','10001','10001','11111','10001','10001','10001'],
  '2':['11110','00001','00001','01110','10000','10000','11111'],
  '3':['11110','00001','00001','01110','00001','00001','11110'],
  '4':['10010','10010','10010','11111','00010','00010','00010'],
  '5':['11111','10000','10000','11110','00001','00001','11110'],
  '6':['01111','10000','10000','11110','10001','10001','01110'],
  '7':['11111','00001','00010','00100','01000','01000','01000'],
  '8':['01110','10001','10001','01110','10001','10001','01110'],
  '9':['01110','10001','10001','01111','00001','00001','11110'],
  '1':['00100','01100','00100','00100','00100','00100','01110'],
  '0':['01110','10001','10011','10101','11001','10001','01110'],
  J:['00111','00010','00010','00010','10010','10010','01100'],
  Q:['01110','10001','10001','10001','10101','10010','01101'],
  K:['10001','10010','10100','11000','10100','10010','10001'],
};

const CARD_W = 82;
const CARD_H = 116;
const GAP = 10;
const PAD = 12;
const ROW_GAP = 16;

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
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function createSurface(width, height) {
  const pixels = Buffer.alloc(width * height * 4, 0);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    pixels[offset] = r; pixels[offset + 1] = g; pixels[offset + 2] = b; pixels[offset + 3] = a;
  };
  const rect = (x, y, w, h, color) => {
    for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) set(xx, yy, ...color);
  };
  return { width, height, pixels, set, rect };
}

function roundedRect(surface, x, y, w, h, radius, color) {
  for (let yy = 0; yy < h; yy += 1) {
    for (let xx = 0; xx < w; xx += 1) {
      const dx = Math.max(radius - xx, 0, xx - (w - 1 - radius));
      const dy = Math.max(radius - yy, 0, yy - (h - 1 - radius));
      if (dx * dx + dy * dy <= radius * radius) surface.set(x + xx, y + yy, ...color);
    }
  }
}

function drawGlyph(surface, glyph, x, y, scale, color) {
  const rows = FONT[glyph]; if (!rows) return;
  rows.forEach((row, yy) => [...row].forEach((bit, xx) => { if (bit === '1') surface.rect(x + xx * scale, y + yy * scale, scale, scale, color); }));
}

function drawRank(surface, rank, x, y, scale, color) {
  let cursor = x;
  for (const glyph of String(rank)) {
    drawGlyph(surface, glyph, cursor, y, scale, color);
    cursor += 6 * scale;
  }
}

function circle(surface, cx, cy, radius, color) {
  for (let y = -radius; y <= radius; y += 1) for (let x = -radius; x <= radius; x += 1) if (x*x + y*y <= radius*radius) surface.set(cx+x, cy+y, ...color);
}

function triangle(surface, ax, ay, bx, by, cx, cy, color) {
  const minX = Math.floor(Math.min(ax,bx,cx)), maxX = Math.ceil(Math.max(ax,bx,cx));
  const minY = Math.floor(Math.min(ay,by,cy)), maxY = Math.ceil(Math.max(ay,by,cy));
  const area = (x1,y1,x2,y2,x3,y3) => (x1*(y2-y3)+x2*(y3-y1)+x3*(y1-y2));
  const full = area(ax,ay,bx,by,cx,cy);
  for (let y=minY;y<=maxY;y+=1) for (let x=minX;x<=maxX;x+=1) {
    const a=area(x,y,bx,by,cx,cy)/full, b=area(ax,ay,x,y,cx,cy)/full, c=1-a-b;
    if (a>=0&&b>=0&&c>=0) surface.set(x,y,...color);
  }
}

function suitKind(suit='') {
  if (suit === '♥' || suit === '♡') return 'heart';
  if (suit === '♦' || suit === '♢') return 'diamond';
  if (suit === '♣' || suit === '♧') return 'club';
  return 'spade';
}

function drawSuit(surface, suit, cx, cy, size, color) {
  const kind = suitKind(suit);
  if (kind === 'diamond') {
    triangle(surface,cx,cy-size,cx+size,cy,cx,cy+size,color); triangle(surface,cx,cy-size,cx-size,cy,cx,cy+size,color); return;
  }
  if (kind === 'heart') {
    circle(surface,cx-size/2,cy-size/3,size/2,color); circle(surface,cx+size/2,cy-size/3,size/2,color);
    triangle(surface,cx-size,cy-size/3,cx+size,cy-size/3,cx,cy+size,color); return;
  }
  if (kind === 'club') {
    circle(surface,cx,cy-size/2,size/2,color); circle(surface,cx-size/2,cy,size/2,color); circle(surface,cx+size/2,cy,size/2,color);
    surface.rect(Math.round(cx-size/5),Math.round(cy),Math.round(size*2/5),Math.round(size),color); return;
  }
  triangle(surface,cx-size,cy+size/3,cx+size,cy+size/3,cx,cy-size,color);
  circle(surface,cx-size/2,cy+size/4,size/2,color); circle(surface,cx+size/2,cy+size/4,size/2,color);
  surface.rect(Math.round(cx-size/5),Math.round(cy+size/4),Math.round(size*2/5),Math.round(size*3/4),color);
}

function drawCard(surface, card, x, y, hidden = false) {
  const border = [185,190,198,255], white = [250,250,250,255];
  roundedRect(surface,x,y,CARD_W,CARD_H,8,border); roundedRect(surface,x+2,y+2,CARD_W-4,CARD_H-4,7,white);
  if (hidden) {
    roundedRect(surface,x+7,y+7,CARD_W-14,CARD_H-14,5,[39,76,119,255]);
    for (let yy=y+13; yy<y+CARD_H-10; yy+=10) for (let xx=x+13; xx<x+CARD_W-10; xx+=10) circle(surface,xx,yy,2,[221,230,242,255]);
    return;
  }
  const red = suitKind(card.suit) === 'heart' || suitKind(card.suit) === 'diamond';
  const color = red ? [194,39,45,255] : [25,25,28,255];
  drawRank(surface,card.rank,x+8,y+8,3,color); drawSuit(surface,card.suit,x+18,y+40,7,color);
  drawSuit(surface,card.suit,x+CARD_W/2,y+CARD_H/2+10,17,color);
}

function encodePng(surface) {
  const stride = surface.width * 4;
  const raw = Buffer.alloc((stride + 1) * surface.height);
  for (let y=0;y<surface.height;y+=1) {
    raw[y*(stride+1)] = 0;
    surface.pixels.copy(raw,y*(stride+1)+1,y*stride,(y+1)*stride);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(surface.width,0); ihdr.writeUInt32BE(surface.height,4); ihdr[8]=8; ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}

export function renderCardRows(rows = []) {
  const normalized = rows.filter(row => Array.isArray(row?.cards) && row.cards.length).map(row => ({ cards: row.cards, hideFrom: row.hideFrom ?? Infinity }));
  const maxCards = Math.max(1,...normalized.map(row => row.cards.length));
  const width = PAD*2 + maxCards*CARD_W + Math.max(0,maxCards-1)*GAP;
  const height = PAD*2 + Math.max(1,normalized.length)*CARD_H + Math.max(0,normalized.length-1)*ROW_GAP;
  const surface = createSurface(width,height);
  normalized.forEach((row,rowIndex) => row.cards.forEach((card,index) => drawCard(surface,card,PAD+index*(CARD_W+GAP),PAD+rowIndex*(CARD_H+ROW_GAP),index>=row.hideFrom)));
  return encodePng(surface);
}
