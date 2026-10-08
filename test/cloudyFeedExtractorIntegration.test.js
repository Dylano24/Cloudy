import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGalleryDlUrls, parseYtDlpItems, discoverExtractorMedia,
} from '../src/services/cloudyFeedExtractorService.js';
import { targetVideoBitrateKbps } from '../src/services/cloudyFeedVideoExtractor.js';
import { mediaItemKey, eligibleMediaForSource } from '../src/services/cloudyFeedService.js';

test('yt-dlp metadata discovers real public video posts, not thumbnails or DRM', () => {
  const items = parseYtDlpItems({
    entries: [
      { id: 'a1', title: 'Clip', webpage_url: 'https://media.example.com/watch/a1',
        extractor_key: 'Site', formats: [{ vcodec: 'avc1', protocol: 'm3u8_native' }] },
      { id: 'a1', title: 'Duplicate', webpage_url: 'https://media.example.com/watch/a1',
        extractor_key: 'Site', formats: [{ vcodec: 'avc1' }] },
      { id: 'encrypted', webpage_url: 'https://media.example.com/watch/secret',
        has_drm: true, formats: [{ vcodec: 'avc1' }] },
      { id: 'thumb', webpage_url: 'https://media.example.com/watch/thumbnail',
        formats: [{ vcodec: 'none' }] },
      { id: 'private', webpage_url: 'http://127.0.0.1/private',
        formats: [{ vcodec: 'avc1' }] },
      { id: 'live', webpage_url: 'https://media.example.com/watch/live',
        is_live: true, formats: [{ vcodec: 'avc1' }] },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Clip');
  assert.equal(items[0].mediaExtractor, 'yt-dlp');
  assert.equal(items[0].video, 'https://media.example.com/watch/a1');
  assert.equal(items[0].image, null);
  assert.equal(items[0].dedupKey, 'yt-dlp:Site:a1');
  assert.equal(mediaItemKey(items[0]), 'yt-dlp:Site:a1');
  assert.deepEqual(eligibleMediaForSource(items, 'https://media.example.com/', 'picture'), []);
});

test('gallery-dl results keep only HTTPS pictures and avoid repeated URLs', () => {
  const result = parseGalleryDlUrls(
    'https://cdn.example.org/pic1.jpg?expires=123\n'
    + 'https://cdn.example.org/pic1.jpg?expires=123\n'
    + 'https://cdn.example.org/clip.mp4\n'
    + 'http://cdn.example.org/unsafe.png\n'
    + 'https://cdn.example.org/pic2.webp\n'
    + 'https://127.0.0.1/private.png\n',
    'https://example.org/gallery',
  );
  assert.deepEqual(result.map(x => x.image), [
    'https://cdn.example.org/pic1.jpg?expires=123',
    'https://cdn.example.org/pic2.webp',
  ]);
  assert.ok(result.every(x => x.video === null));
  assert.equal(result[0].dedupKey, 'gallery-dl:https://cdn.example.org/pic1.jpg');
});

test('media type chooses the specialist without introducing UI fields', async () => {
  const calls = [];
  const runner = async (binary, args) => {
    calls.push({ binary, args });
    if (binary === 'gallery-dl') return 'https://cdn.example.org/picture.jpg\n';
    return JSON.stringify({ id: 'clip', webpage_url: 'https://example.org/watch/clip',
      formats: [{ vcodec: 'avc1' }] });
  };
  const video = await discoverExtractorMedia('https://example.org/', 'video', runner);
  assert.equal(video.length, 1);
  assert.equal(video[0].mediaExtractor, 'yt-dlp');
  const picture = await discoverExtractorMedia('https://example.org/', 'picture', runner);
  assert.equal(picture.length, 1);
  assert.equal(picture[0].image, 'https://cdn.example.org/picture.jpg');
  assert.deepEqual(calls.map(x => x.binary), ['yt-dlp', 'gallery-dl']);
  assert.ok(calls.every(x => x.args.at(-1) === 'https://example.org/'));
});

test('unknown video site cannot silently fall back to a thumbnail', async () => {
  const result = await discoverExtractorMedia('https://example.org/', 'video',
    async () => JSON.stringify({ webpage_url: 'https://example.org/', thumbnail: 'https://example.org/a.jpg' }));
  assert.deepEqual(result, []);
});

test('ffmpeg bitrate optimization respects Discord limits and never trims a long video', () => {
  assert.ok(targetVideoBitrateKbps(10 * 1024 * 1024, 35) > 110);
  assert.throws(() => targetVideoBitrateKbps(10 * 1024 * 1024, 400), /cannot fit/);
  assert.throws(() => targetVideoBitrateKbps(500_000, 240), /too long/);
});
