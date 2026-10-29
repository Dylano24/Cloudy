import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { convertToStorableImage, isHeifImage } from '../src/services/embedMediaImageConvert.js';
import {
  prefetchDiscordEmbedMedia, storeEmbedMediaBuffer, storeExistingDiscordEmbedMedia,
} from '../src/services/embedMediaStorageService.js';

const heic = await readFile('test/fixtures/iphone-photo.heic');
const avif = await readFile('test/fixtures/picture.avif');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

async function storage(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudy-media-convert-'));
  const previous = { dir: process.env.CLOUDY_EMBED_MEDIA_DIR, base: process.env.CLOUDY_EMBED_MEDIA_BASE_URL };
  process.env.CLOUDY_EMBED_MEDIA_DIR = dir;
  process.env.CLOUDY_EMBED_MEDIA_BASE_URL = 'https://cloudy.example.com';
  t.after(async () => {
    for (const [key, value] of [['CLOUDY_EMBED_MEDIA_DIR', previous.dir], ['CLOUDY_EMBED_MEDIA_BASE_URL', previous.base]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('an iPhone HEIC photo is recognised; AVIF and PNG are not treated as HEIC', () => {
  assert.equal(isHeifImage(heic), true);
  assert.equal(isHeifImage(avif), false);
  assert.equal(isHeifImage(png), false);
  assert.equal(isHeifImage(Buffer.from('not a picture at all')), false);
});

test('a real iPhone HEIC photo becomes a JPG banner (decoded off the main thread)', async t => {
  const dir = await storage(t);
  const url = await storeEmbedMediaBuffer(heic);
  assert.match(url, /^https:\/\/cloudy\.example\.com\/cloudy-embed-media\/[a-f0-9]{64}\.jpg$/);
  const stored = await readFile(path.join(dir, url.split('/').at(-1)));
  assert.deepEqual([...stored.subarray(0, 3)], [0xff, 0xd8, 0xff]);
});

test('other formats (e.g. AVIF) become a PNG banner through local ffmpeg', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async t => {
  await storage(t);
  const url = await storeEmbedMediaBuffer(avif);
  assert.match(url, /\.png$/);
});

test('a picture that cannot be converted gives a clear refusal, nothing is stored', async t => {
  const dir = await storage(t);
  await assert.rejects(storeEmbedMediaBuffer(Buffer.from('<html>not a picture</html>'), {
    convert: async () => { throw new Error('cannot decode'); },
  }), /Unsupported Embed Builder media data/);
  assert.deepEqual((await readdir(dir)).filter(name => !name.startsWith('.')), []);
  // The converter itself is only asked for formats Cloudy cannot store as-is.
  let asked = 0;
  await storeEmbedMediaBuffer(png, { convert: async () => { asked += 1; return png; } });
  assert.equal(asked, 0);
});

test('Add media starts the permanent copy; Post/Save reuse it without downloading again', async t => {
  await storage(t);
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    downloads += 1;
    return new Response(png, { status: 200 });
  });
  const upload = 'https://cdn.discordapp.com/ephemeral-attachments/1534506224312389863/1900000000000000001/IMG_4466.png?ex=1';
  prefetchDiscordEmbedMedia(upload);
  const [post, save] = await Promise.all([storeExistingDiscordEmbedMedia(upload), storeExistingDiscordEmbedMedia(upload)]);
  assert.equal(post, save);
  assert.equal(downloads, 1, 'one download for Add media, Post and Save together');

  // A failed copy is tried again on the next Post, never remembered.
  const broken = 'https://cdn.discordapp.com/ephemeral-attachments/1534506224312389863/1900000000000000002/x.png?ex=1';
  t.mock.method(globalThis, 'fetch', async () => new Response('busy', { status: 503 }));
  await assert.rejects(storeExistingDiscordEmbedMedia(broken), /unavailable/);
  t.mock.method(globalThis, 'fetch', async () => new Response(png, { status: 200 }));
  assert.match(await storeExistingDiscordEmbedMedia(broken), /\.png$/);
});

test('without a usable converter for the format the HEIC path falls back to ffmpeg', async () => {
  const calls = [];
  await assert.rejects(convertToStorableImage(heic, {
    heif: async () => { calls.push('heif'); throw new Error('no decoder'); },
    run: async binary => { calls.push(binary); throw new Error('cannot read'); },
  }));
  assert.deepEqual(calls, ['heif', 'ffmpeg']);
});
