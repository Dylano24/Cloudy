// Public, immutable media for owner-created Embed Builder messages.
// Railway volume is required: CLOUDY_EMBED_MEDIA_DIR=/data/cloudy-embed-media.
// Standalone URLs avoid Discord's attachment:// duplicate-on-PATCH behavior.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BYTES = 25 * 1024 * 1024;
const MEDIA_ROUTE = '/cloudy-embed-media';
const FILENAME = /^[a-f0-9]{64}\.(gif|png|jpg|webp)$/;

function mediaDir() {
  return String(process.env.CLOUDY_EMBED_MEDIA_DIR || '').trim();
}

export function embedMediaStorageEnabled() {
  return Boolean(mediaDir());
}

function mediaBaseUrl() {
  const value = String(process.env.CLOUDY_EMBED_MEDIA_BASE_URL
    || 'https://cloudy-production-b24f.up.railway.app').trim();
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('CLOUDY_EMBED_MEDIA_BASE_URL must use HTTPS');
  return url.origin;
}

function imageExtension(buffer) {
  if (buffer.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return 'gif';
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

export async function storeEmbedMediaBuffer(input) {
  if (!embedMediaStorageEnabled()) return null;
  const buffer = Buffer.from(input || []);
  if (!buffer.length || buffer.length > MAX_BYTES) throw new Error('Invalid Embed Builder media size');
  const extension = imageExtension(buffer);
  if (!extension) throw new Error('Unsupported Embed Builder media data');
  const filename = createHash('sha256').update(buffer).digest('hex') + '.' + extension;
  const root = mediaDir();
  await mkdir(root, { recursive: true });
  // Keep readers away from partly written images.
  const temporary = join(root, '.' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, buffer, { flag: 'wx' });
    await rename(temporary, join(root, filename));
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return mediaBaseUrl() + MEDIA_ROUTE + '/' + filename;
}

export async function storeExistingDiscordEmbedMedia(url) {
  if (!embedMediaStorageEnabled()) return null;
  const address = new URL(String(url || ''));
  if (address.protocol !== 'https:'
    || !['cdn.discordapp.com', 'media.discordapp.net'].includes(address.hostname)
    || !/^\/(?:ephemeral-)?attachments\/\d+\/\d+\//.test(address.pathname)) {
    throw new Error('Media migration only accepts Discord attachment CDN URLs');
  }
  const response = await fetch(address, {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': 'Cloudy-Embed-Builder/1.0' },
  });
  if (!response.ok || !response.body) throw new Error('Discord media source unavailable');
  if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) {
    throw new Error('Discord media exceeds upload limit');
  }
  const parts = [];
  let total = 0;
  for await (const part of response.body) {
    total += part.byteLength;
    if (total > MAX_BYTES) {
      await response.body.cancel?.().catch(() => {});
      throw new Error('Discord media exceeds upload limit');
    }
    parts.push(Buffer.from(part));
  }
  return storeEmbedMediaBuffer(Buffer.concat(parts, total));
}

export function registerEmbedMediaRoutes(app) {
  app.get(MEDIA_ROUTE + '/:filename', async (req, res) => {
    const filename = String(req.params.filename || '');
    if (!embedMediaStorageEnabled() || !FILENAME.test(filename)) {
      return res.sendStatus(404);
    }
    try {
      const buffer = await readFile(join(mediaDir(), filename));
      const extension = filename.split('.').at(-1);
      const type = {gif:'image/gif',png:'image/png',jpg:'image/jpeg',webp:'image/webp'}[extension];
      res.set('Content-Type', type);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(buffer);
    } catch {
      return res.sendStatus(404);
    }
  });
}
