import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import {
  registerDeletedMediaRoutes,
  removeExpiredDeletedMedia,
  storeDeletedVideo,
} from '../src/services/deletedMediaService.js';

async function server(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cloudy-deleted-page-'));
  process.env.CLOUDY_EMBED_MEDIA_DIR = dir;
  process.env.CLOUDY_EMBED_MEDIA_BASE_URL = 'https://cloudy.test';
  const app = express();
  registerDeletedMediaRoutes(app);
  const listener = await new Promise(resolve => { const handle = app.listen(0, '127.0.0.1', () => resolve(handle)); });
  t.after(async () => {
    await new Promise(resolve => { listener.close(resolve); });
    delete process.env.CLOUDY_EMBED_MEDIA_DIR;
    delete process.env.CLOUDY_EMBED_MEDIA_BASE_URL;
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, local: url => url.replace('https://cloudy.test', `http://127.0.0.1:${listener.address().port}`) };
}

test('the link opens a page that plays the deleted video, with seeking for iPhone', async t => {
  const { local } = await server(t);
  const video = Buffer.from('0123456789abcdef');
  const pageUrl = await storeDeletedVideo(video, { name: 'clip <1>.mov', contentType: 'video/quicktime' });
  assert.match(pageUrl, /^https:\/\/cloudy\.test\/deleted-media\/[A-Za-z0-9_-]{32}$/);

  const page = await fetch(local(pageUrl));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  const html = await page.text();
  assert.match(html, /<video src="\/deleted-media\/[A-Za-z0-9_-]{32}\/video" controls autoplay playsinline/);
  assert.match(html, /clip &lt;1&gt;\.mov/, 'file name is escaped');

  const full = await fetch(local(pageUrl + '/video'));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), video);

  const part = await fetch(local(pageUrl + '/video'), { headers: { Range: 'bytes=4-7' } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), '4567');
});

test('unknown, malformed and expired links show nothing', async t => {
  const { dir, local } = await server(t);
  assert.equal((await fetch(local('https://cloudy.test/deleted-media/' + 'a'.repeat(32)))).status, 404);
  assert.equal((await fetch(local('https://cloudy.test/deleted-media/..%2F..%2Fetc'))).status, 404);
  assert.equal(await storeDeletedVideo(Buffer.from('x'), { name: 'a.exe', contentType: 'application/octet-stream' }), null);

  const pageUrl = await storeDeletedVideo(Buffer.from('old video'), { name: 'old.mp4', contentType: 'video/mp4' });
  const token = pageUrl.split('/').at(-1);
  const metaPath = join(dir, 'deleted-media', token + '.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  await writeFile(metaPath, JSON.stringify({ ...meta, expiresAt: Date.now() - 1 }));
  assert.equal((await fetch(local(pageUrl))).status, 404);
  assert.equal((await fetch(local(pageUrl + '/video'))).status, 404);
  assert.equal(await removeExpiredDeletedMedia({ force: true }), 1);
  await assert.rejects(readFile(join(dir, 'deleted-media', token + '.video')));
});
