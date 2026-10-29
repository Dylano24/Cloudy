// Embed Builder pictures that Discord accepts but a banner link cannot carry
// as-is (iPhone HEIC/HEIF photos, AVIF, BMP, TIFF, ...) are converted once:
// HEIC/HEIF to JPG in a worker thread, everything else to PNG with a local
// ffmpeg that only reads the local file.
import { Worker } from 'node:worker_threads';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runLocalCommand } from './cloudyFeedVideoClip.js';

const CONVERT_TIMEOUT_MS = 30_000;
const LARGE_PNG_BYTES = 20 * 1024 * 1024;
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

export function isHeifImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16 || buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  const boxSize = Math.min(buffer.readUInt32BE(0), buffer.length, 256);
  const brands = [buffer.toString('ascii', 8, 12)];
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) brands.push(buffer.toString('ascii', offset, offset + 4));
  // AVIF is decoded by ffmpeg instead.
  return brands.some(brand => HEIF_BRANDS.has(brand)) && !brands.includes('avif');
}

// First bytes of an unreadable picture, for the log only (never the content).
export function imageSignature(buffer) {
  return Buffer.isBuffer(buffer) ? buffer.subarray(0, 12).toString('hex') : '';
}

function convertHeifInWorker(buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./heicConvertWorker.js', import.meta.url), { workerData: { buffer } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Picture conversion timed out.'));
    }, CONVERT_TIMEOUT_MS);
    timer.unref?.();
    worker.once('message', result => {
      clearTimeout(timer);
      void worker.terminate();
      if (result?.ok) resolve(Buffer.from(result.buffer));
      else reject(new Error('Picture could not be converted: ' + (result?.error || 'unknown')));
    });
    worker.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function convertWithFfmpeg(buffer, run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudy-picture-'));
  try {
    const input = path.join(directory, 'source');
    const output = path.join(directory, 'picture.png');
    await writeFile(input, buffer);
    const encode = (target, codec) => run('ffmpeg', [
      '-nostdin', '-y', '-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', 'file,pipe',
      '-i', input, '-frames:v', '1', ...codec, target,
    ], CONVERT_TIMEOUT_MS);
    await encode(output, ['-c:v', 'png']);
    const png = await readFile(output);
    if (png.length <= LARGE_PNG_BYTES) return png;
    // A big photo stays well within the storage limit as a JPG.
    const jpg = path.join(directory, 'picture.jpg');
    await encode(jpg, ['-q:v', '2']);
    return await readFile(jpg);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** A JPG (from HEIC/HEIF) or PNG copy of a picture Cloudy cannot store as-is. */
export async function convertToStorableImage(buffer, {
  heif = convertHeifInWorker,
  run = runLocalCommand,
} = {}) {
  if (isHeifImage(buffer)) {
    try { return await heif(buffer); } catch { /* fall back to ffmpeg below */ }
  }
  return convertWithFfmpeg(buffer, run);
}
