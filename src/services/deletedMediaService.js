// Deleted-message videos for the Staff/Member/AutoMod logs.
// A video cannot play inside a bot embed, so the log links to a small page on
// Cloudy's own web server that plays it. Files live on the Railway volume
// (CLOUDY_EMBED_MEDIA_DIR/deleted-media) behind an unguessable token and are
// removed automatically after DELETED_MEDIA_RETENTION_DAYS (default 30).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DELETED_MEDIA_ROUTE = '/deleted-media';
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const DAY_MS = 24 * 60 * 60_000;
// Browsers play H.264 QuickTime files as MP4; other types keep their own.
const PLAYABLE_TYPES = new Map([
  ['video/mp4', 'video/mp4'],
  ['video/quicktime', 'video/mp4'],
  ['video/webm', 'video/webm'],
  ['video/ogg', 'video/ogg'],
  ['video/x-m4v', 'video/mp4'],
]);

function storageDir() {
  const root = String(process.env.CLOUDY_EMBED_MEDIA_DIR || '').trim();
  return root ? join(root, 'deleted-media') : '';
}

function retentionMs() {
  const days = Number(process.env.DELETED_MEDIA_RETENTION_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : 30) * DAY_MS;
}

function baseUrl() {
  const value = String(process.env.CLOUDY_EMBED_MEDIA_BASE_URL
    || 'https://cloudy-production-b24f.up.railway.app').trim();
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('CLOUDY_EMBED_MEDIA_BASE_URL must use HTTPS');
  return url.origin;
}

export function deletedMediaStorageEnabled() {
  return Boolean(storageDir());
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function readMeta(token) {
  if (!TOKEN.test(String(token || '')) || !deletedMediaStorageEnabled()) return null;
  try {
    const meta = JSON.parse(await readFile(join(storageDir(), token + '.json'), 'utf8'));
    if (!meta || Date.now() > Number(meta.expiresAt)) return null;
    return meta;
  } catch {
    return null;
  }
}

/**
 * Stores one deleted video and returns the page that plays it, or null when
 * the volume is not configured or the type cannot play in a browser.
 */
export async function storeDeletedVideo(buffer, { name = 'video', contentType = '' } = {}) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!deletedMediaStorageEnabled() || !PLAYABLE_TYPES.has(type) || !buffer?.length) return null;
  const root = storageDir();
  await mkdir(root, { recursive: true });
  const token = randomBytes(24).toString('base64url');
  const now = Date.now();
  const meta = { name: String(name).slice(0, 200), type, size: buffer.length, createdAt: now, expiresAt: now + retentionMs() };
  // Readers only ever see complete files.
  const temporary = join(root, '.' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, buffer, { flag: 'wx' });
    await rename(temporary, join(root, token + '.video'));
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  await writeFile(join(root, token + '.json'), JSON.stringify(meta));
  void removeExpiredDeletedMedia().catch(() => {});
  return `${baseUrl()}${DELETED_MEDIA_ROUTE}/${token}`;
}

let lastSweepAt = 0;
export async function removeExpiredDeletedMedia({ force = false } = {}) {
  if (!deletedMediaStorageEnabled()) return 0;
  if (!force && Date.now() - lastSweepAt < 60 * 60_000) return 0;
  lastSweepAt = Date.now();
  let removed = 0;
  const root = storageDir();
  const names = await readdir(root).catch(() => []);
  for (const file of names.filter(entry => entry.endsWith('.json'))) {
    const token = file.slice(0, -5);
    let expired;
    try {
      const meta = JSON.parse(await readFile(join(root, file), 'utf8'));
      expired = Date.now() > Number(meta.expiresAt);
    } catch {
      // Unreadable metadata: fall back to the file age.
      const info = await stat(join(root, file)).catch(() => null);
      expired = !info || Date.now() - info.mtimeMs > retentionMs();
    }
    if (!expired) continue;
    await rm(join(root, token + '.video'), { force: true }).catch(() => {});
    await rm(join(root, file), { force: true }).catch(() => {});
    removed += 1;
  }
  return removed;
}

function videoPage(token, meta) {
  const name = escapeHtml(meta.name);
  const source = `${DELETED_MEDIA_ROUTE}/${token}/video`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${name} · Cloudy</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #0f1012; color: #e6e6e6; font: 15px/1.4 system-ui, -apple-system, sans-serif; }
  main { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 16px; box-sizing: border-box; }
  video { width: 100%; max-width: 900px; max-height: 80vh; background: #000; border-radius: 10px; }
  .name { opacity: .75; word-break: break-all; text-align: center; }
  a { color: #8ab4ff; }
</style>
</head>
<body>
<main>
  <video src="${source}" controls autoplay playsinline preload="auto"></video>
  <div class="name">${name}</div>
  <a href="${source}" download="${name}">Download</a>
</main>
</body>
</html>`;
}

export function registerDeletedMediaRoutes(app) {
  // Startup clean-up of videos past their retention.
  void removeExpiredDeletedMedia({ force: true }).catch(() => {});
  const privateHeaders = res => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, max-age=3600');
  };

  app.get(`${DELETED_MEDIA_ROUTE}/:token`, async (req, res) => {
    const token = String(req.params.token || '');
    const meta = await readMeta(token);
    if (!meta) return res.sendStatus(404);
    privateHeaders(res);
    res.set('Content-Security-Policy', "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.type('html');
    return res.status(200).send(videoPage(token, meta));
  });

  // Range requests are required for iPhone playback and seeking.
  app.get(`${DELETED_MEDIA_ROUTE}/:token/video`, async (req, res) => {
    const token = String(req.params.token || '');
    const meta = await readMeta(token);
    if (!meta) return res.sendStatus(404);
    privateHeaders(res);
    return res.sendFile(token + '.video', {
      root: storageDir(),
      acceptRanges: true,
      dotfiles: 'deny',
      headers: { 'Content-Type': PLAYABLE_TYPES.get(meta.type) || 'video/mp4' },
    }, error => {
      if (error && !res.headersSent) res.sendStatus(404);
    });
  });
}
