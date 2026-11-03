import test from 'node:test';
import assert from 'node:assert/strict';
import { VIDEO_GIF_QUALITY_PRESETS, videoGifPaletteFilter } from '../src/services/videoGifService.js';

test('Embed Builder video-to-GIF starts with high-quality resolution and framerate', () => {
  assert.deepEqual(VIDEO_GIF_QUALITY_PRESETS[0], { width: 960, fps: 20 });
  assert.ok(VIDEO_GIF_QUALITY_PRESETS.length >= 6);
  assert.deepEqual(VIDEO_GIF_QUALITY_PRESETS.at(-1), { width: 320, fps: 6 });
  for (let i = 1; i < VIDEO_GIF_QUALITY_PRESETS.length; i++) {
    assert.ok(VIDEO_GIF_QUALITY_PRESETS[i].width < VIDEO_GIF_QUALITY_PRESETS[i - 1].width);
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
