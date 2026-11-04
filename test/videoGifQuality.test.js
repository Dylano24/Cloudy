import test from 'node:test';
import assert from 'node:assert/strict';
import { VIDEO_GIF_QUALITY_PRESETS, videoGifPaletteFilter, selectFittingVideoGif } from '../src/services/videoGifService.js';

test('Embed Builder video-to-GIF starts with high-quality resolution and framerate', () => {
  assert.deepEqual(VIDEO_GIF_QUALITY_PRESETS[0], { width: 1280, fps: 30 });
  assert.deepEqual(VIDEO_GIF_QUALITY_PRESETS[1], { width: 1080, fps: 26 });
  assert.deepEqual(VIDEO_GIF_QUALITY_PRESETS[2], { width: 960, fps: 24 });
  assert.ok(VIDEO_GIF_QUALITY_PRESETS.length >= 6);
  assert.deepEqual(VIDEO_GIF_QUALITY_PRESETS.at(-1), { width: 320, fps: 6 });
  for (let i = 1; i < VIDEO_GIF_QUALITY_PRESETS.length; i++) {
    assert.ok(VIDEO_GIF_QUALITY_PRESETS[i].width <= VIDEO_GIF_QUALITY_PRESETS[i - 1].width);
    if (VIDEO_GIF_QUALITY_PRESETS[i].width === VIDEO_GIF_QUALITY_PRESETS[i - 1].width) {
      assert.ok(VIDEO_GIF_QUALITY_PRESETS[i].fps < VIDEO_GIF_QUALITY_PRESETS[i - 1].fps);
    }
    assert.ok(VIDEO_GIF_QUALITY_PRESETS[i].fps <= VIDEO_GIF_QUALITY_PRESETS[i - 1].fps);
  }
});

test('GIF generation preserves native aspect ratio, supports all 256 colours and high-fidelity dithering', () => {
  const filter = videoGifPaletteFilter(960, 20);
  assert.match(filter, /fps=20/);
  assert.match(filter, /scale='min\(960,iw\)':-2:flags=lanczos/);
  assert.match(filter, /palettegen=max_colors=256:stats_mode=diff/);
  assert.match(filter, /paletteuse=dither=sierra2_4a/);
  assert.doesNotMatch(filter, /max_colors=128|bayer_scale/);
});

test('original uploaded GIF storage remains bit-for-bit lossless and is never re-encoded', async () => {
  const { storeEmbedMediaBuffer } = await import('../src/services/embedMediaStorageService.js');
  // Existing quality improvements apply only to video-to-GIF conversions.
  // Existing GIF uploads already go directly to immutable, content-addressed storage.
  const source = await import('node:fs/promises');
  const url = await import('node:url');
  const file = await import('node:path');
  const gif = await source.readFile(file.join(file.dirname(url.fileURLToPath(import.meta.url)),
    '../assets/cloudy-c-logo-auf-auf.gif'));
  const called = [];
  const old = process.env.CLOUDY_EMBED_MEDIA_DIR;
  const { mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(file.join(tmpdir(), 'cloudy-gif-quality-'));
  try {
    process.env.CLOUDY_EMBED_MEDIA_DIR = dir;
    const stored = await storeEmbedMediaBuffer(gif, { convert: (...args) => {
      called.push(args);
      throw new Error('Original GIFs must never be converted');
    } });
    const filename = stored.split('/').at(-1);
    assert.ok(filename.endsWith('.gif'));
    assert.deepEqual(await readFile(file.join(dir, filename)), gif);
    assert.deepEqual(called, []);
  } finally {
    if (old === undefined) delete process.env.CLOUDY_EMBED_MEDIA_DIR;
    else process.env.CLOUDY_EMBED_MEDIA_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('oversized high-quality videos find the sharpest fitting GIF in far fewer conversions', async () => {
  const attempted = [];
  const payload = await selectFittingVideoGif(async (_, index) => {
    attempted.push(index);
    // All choices sharper than index 4 exceed 9 MB.
    return Buffer.alloc(index < 4 ? 10_000 : 8_000, index);
  }, { maxBytes: 9_000 });
  assert.equal(payload[0], 4);
  assert.equal(attempted[0], 0, 'start at highest quality');
  assert.ok(attempted.length <= 5, 'no 11-attempt exhaustive encode');
  assert.ok(attempted.every(index => index >= 0 && index < VIDEO_GIF_QUALITY_PRESETS.length));

  const highest = [];
  const best = await selectFittingVideoGif(async (_, index) => {
    highest.push(index);
    return Buffer.alloc(1000, index);
  }, { maxBytes: 9_000 });
  assert.deepEqual(highest, [0], 'already-fitting GIF does not get re-encoded');
  assert.equal(best[0], 0);

  const impossible = await selectFittingVideoGif(async () => Buffer.alloc(10_000),
    { maxBytes: 9_000 });
  assert.equal(impossible, null, 'oversized video still respects the upload limit');
});
