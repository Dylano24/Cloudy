import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  videoFileType, videoUploadLimit, bufferVideoStream, makeVideoAttachmentMessage,
} from '../src/services/cloudyFeedMediaUpload.js';

const mp4 = Buffer.alloc(24);
mp4.write('ftyp', 4, 'ascii');
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01,
  0x42, 0xf7, 0x81, 0x01]);

test('videos must be playable MP4 or WebM, not HTML or arbitrary bytes', () => {
  assert.equal(videoFileType(mp4), 'mp4');
  assert.equal(videoFileType(webm), 'webm');
  assert.equal(videoFileType(Buffer.from('<html>This is not video</html>')), null);
  assert.equal(videoFileType(Buffer.from('MP4')), null);
});

test('Discord upload limits prevent oversized video downloads', () => {
  assert.equal(videoUploadLimit(), 10 * 1024 * 1024);
  assert.equal(videoUploadLimit(8 * 1024 * 1024), 8 * 1024 * 1024);
  assert.equal(videoUploadLimit(100 * 1024 * 1024), 25 * 1024 * 1024);
  assert.equal(videoUploadLimit(25), 25);
});

test('video bytes are bounded and bad content is rejected before posting', async () => {
  const good = await bufferVideoStream(Readable.from([mp4]), 100);
  assert.equal(good.extension, 'mp4');
  assert.deepEqual(good.buffer, mp4);
  await assert.rejects(bufferVideoStream(Readable.from([mp4, mp4]), 30), /too large/);
  await assert.rejects(bufferVideoStream(Readable.from([Buffer.from('<html>bad</html>')]), 100),
    /MP4 or WebM/);
});

test('native Discord video attachment has no outbound URL or link-only fallback', async () => {
  const urls = [];
  const message = await makeVideoAttachmentMessage('https://cdn.example.org/a.mp4', 100, async (url, limit) => {
    urls.push({ url, limit });
    return { buffer: mp4, extension: 'mp4' };
  });
  assert.deepEqual(urls, [{ url: 'https://cdn.example.org/a.mp4', limit: 100 }]);
  assert.equal(message.files.length, 1);
  assert.equal(message.files[0].name, 'cloudy-video.mp4');
  assert.deepEqual(message.files[0].attachment, mp4);
  assert.equal(Object.hasOwn(message, 'content'), false);
  assert.equal(Object.hasOwn(message, 'embeds'), false);
  assert.deepEqual(message.allowedMentions, { parse: [] });
});

test('too-large or malformed media never becomes a link post', async () => {
  await assert.rejects(makeVideoAttachmentMessage('https://example.org/video', 12,
    async () => ({ buffer: mp4, extension: 'mp4' })), /not a supported playable Discord attachment/);
  await assert.rejects(makeVideoAttachmentMessage('https://example.org/video', 200,
    async () => ({ buffer: Buffer.from('Hello'), extension: 'mp4' })), /not a supported playable Discord attachment/);
});
