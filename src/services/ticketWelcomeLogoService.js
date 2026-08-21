import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

export const TICKET_WELCOME_LOGO_FILENAME = 'cloudy-ticket-welcome-c.png';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CANVAS_WIDTH = 3200;
const CANVAS_HEIGHT = 1200;
// Same visible scale as Discord's welcome thumbnail (~80px at normal embed width),
// while keeping the original 500x500 welcome logo pixels completely unchanged.
const LOGO_X = 2500;
const LOGO_Y = 560;

let cachedLayout = null;
let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

function crc32(buffer) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngToRgba(input) {
  if (!input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Cloudy welcome logo is not a valid PNG.');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString('ascii', offset + 4, offset + 8);
    const data = input.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      transparency = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`Unsupported welcome logo PNG format (bitDepth=${bitDepth}, interlace=${interlace}).`);
  }

  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
  if (!channels) throw new Error(`Unsupported welcome logo PNG color type ${colorType}.`);

  const stride = width * channels;
  const filtered = inflateSync(Buffer.concat(idat));
  const raw = Buffer.alloc(height * stride);
  let sourceOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = filtered[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * stride;
    const previousOffset = (y - 1) * stride;

    for (let x = 0; x < stride; x += 1) {
      const value = filtered[sourceOffset + x];
      const left = x >= channels ? raw[rowOffset + x - channels] : 0;
      const up = y > 0 ? raw[previousOffset + x] : 0;
      const upLeft = (y > 0 && x >= channels) ? raw[previousOffset + x - channels] : 0;

      if (filter === 0) raw[rowOffset + x] = value;
      else if (filter === 1) raw[rowOffset + x] = (value + left) & 0xff;
      else if (filter === 2) raw[rowOffset + x] = (value + up) & 0xff;
      else if (filter === 3) raw[rowOffset + x] = (value + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) raw[rowOffset + x] = (value + paeth(left, up, upLeft)) & 0xff;
      else throw new Error(`Unsupported PNG filter ${filter}.`);
    }
    sourceOffset += stride;
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const out = i * 4;

    if (colorType === 6) {
      const src = i * 4;
      rgba[out] = raw[src];
      rgba[out + 1] = raw[src + 1];
      rgba[out + 2] = raw[src + 2];
      rgba[out + 3] = raw[src + 3];
    } else if (colorType === 2) {
      const src = i * 3;
      rgba[out] = raw[src];
      rgba[out + 1] = raw[src + 1];
      rgba[out + 2] = raw[src + 2];
      rgba[out + 3] = 255;
    } else if (colorType === 3) {
      const index = raw[i];
      const paletteOffset = index * 3;
      rgba[out] = palette?.[paletteOffset] ?? 0;
      rgba[out + 1] = palette?.[paletteOffset + 1] ?? 0;
      rgba[out + 2] = palette?.[paletteOffset + 2] ?? 0;
      rgba[out + 3] = transparency?.[index] ?? 255;
    } else if (colorType === 0) {
      const gray = raw[i];
      rgba[out] = gray;
      rgba[out + 1] = gray;
      rgba[out + 2] = gray;
      rgba[out + 3] = 255;
    } else if (colorType === 4) {
      const src = i * 2;
      const gray = raw[src];
      rgba[out] = gray;
      rgba[out + 1] = gray;
      rgba[out + 2] = gray;
      rgba[out + 3] = raw[src + 1];
    }
  }

  return { width, height, rgba };
}

function encodeRgbaPng(width, height, rgba) {
  const scanlineSize = (width * 4) + 1;
  const raw = Buffer.alloc(scanlineSize * height);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * scanlineSize;
    raw[rowOffset] = 0;
    rgba.copy(raw, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND'),
  ]);
}

export function getTicketWelcomeLogoLayout() {
  if (cachedLayout) return cachedLayout;

  const logoPath = fileURLToPath(new URL('../../assets/cloudy-c-logo.png', import.meta.url));
  const logo = decodePngToRgba(readFileSync(logoPath));
  const canvas = Buffer.alloc(CANVAS_WIDTH * CANVAS_HEIGHT * 4, 0);

  if (LOGO_X + logo.width > CANVAS_WIDTH || LOGO_Y + logo.height > CANVAS_HEIGHT) {
    throw new Error('Cloudy welcome logo does not fit the ticket layout canvas.');
  }

  // Copy the exact original welcome-logo pixels. No redraw and no logo resizing.
  for (let y = 0; y < logo.height; y += 1) {
    const sourceStart = y * logo.width * 4;
    const targetStart = ((LOGO_Y + y) * CANVAS_WIDTH + LOGO_X) * 4;
    logo.rgba.copy(canvas, targetStart, sourceStart, sourceStart + (logo.width * 4));
  }

  cachedLayout = encodeRgbaPng(CANVAS_WIDTH, CANVAS_HEIGHT, canvas);
  return cachedLayout;
}
