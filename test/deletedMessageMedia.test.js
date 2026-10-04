import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { prepareDeletedMessageMedia } from '../src/services/deletedMessageMediaService.js';

test('deleted media preserves binary photos/videos and never uploads an HTML error page', async () => {
  const attachments = new Collection([
    ['photo', { name: 'photo.png', contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/one/photo.png' }],
    ['video', { name: 'video.mp4', contentType: 'video/mp4', url: 'https://cdn.discordapp.com/attachments/one/video.mp4' }],
    ['missing', { name: 'missing.png', contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/one/missing.png' }],
    ['html', { name: 'html.png', contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/one/html.png' }],
    ['large', { name: 'large.mp4', size: 100 * 1024 * 1024, contentType: 'video/mp4', url: 'https://cdn.discordapp.com/attachments/one/large.mp4' }],
  ]);
  const reads = [];
  const result = await prepareDeletedMessageMedia({ attachments }, async (url, options) => {
    reads.push(url);
    assert.equal(options.redirect, 'error');
    if (url.includes('missing')) return new Response('Not found', { status: 404 });
    if (url.includes('html')) return new Response('<html>Error</html>', { headers: { 'content-type': 'text/html' } });
    return new Response(Buffer.from([1, 2, 3, 255]), { headers: { 'content-type': url.includes('video') ? 'video/mp4' : 'image/png' } });
  });
  assert.deepEqual(result.files.map(file => file.name), ['photo.png', 'video.mp4']);
  for (const file of result.files) assert.deepEqual(file.attachment, Buffer.from([1, 2, 3, 255]));
  assert.equal(result.links.length, 3);
  assert.equal(reads.some(url => url.includes('large')), false);
  assert.match(result.links.join('\n'), /no longer available.*not a photo or video.*too large/s);
});
