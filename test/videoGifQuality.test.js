import test from 'node:test';
import assert from 'node:assert/strict';
import { VIDEO_GIF_QUALITY_PRESETS, videoGifPaletteFilter } from '../src/services/videoGifService.js';

test('Embed Builder video-to-GIF preserves 30fps before reducing size', () => {
  assert.deepEqual(VIDEO_GIF_QUALITY_PRESETS[0], { width: 960, fps: 30 });
  assert.deepEqual(VIDEO_GIF_QUALITY_PRESETS[1], { width: 960, fps: 20 },
    'the previous responsive 20fps preset remains as the first fallback');
  assert.ok(VIDEO_GIF_QUALITY_PRESETS.length >= 7);
  assert.deepEqual(VIDEO_GIF_QUALITY_PRESETS.at(-1), { width: 320, fps: 6 });
  for (let i = 1; i < VIDEO_GIF_QUALITY_PRESETS.length; i++) {
    assert.ok(VIDEO_GIF_QUALITY_PRESETS[i].width <= VIDEO_GIF_QUALITY_PRESETS[i - 1].width);
    assert.ok(VIDEO_GIF_QUALITY_PRESETS[i].fps < VIDEO_GIF_QUALITY_PRESETS[i - 1].fps);
  }
});

test('GIF generation retains original size, 256 colours and sharp efficient dithering', () => {
  const filter = videoGifPaletteFilter(960, 30);
  assert.match(filter, /fps=30/);
  assert.match(filter, /scale='min\(960,iw\)':-2:flags=lanczos/,
    'never upscale a video narrower than 960 pixels');
  assert.match(filter, /palettegen=max_colors=256:stats_mode=diff/);
  assert.match(filter, /paletteuse=dither=bayer:bayer_scale=2:diff_mode=rectangle/);
  assert.doesNotMatch(filter, /max_colors=128|sierra2_4a/);
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
