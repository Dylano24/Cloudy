import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection } from 'discord.js';
import { preserveReportAttachments, reportAttachmentLines } from '../src/services/reportAttachmentService.js';

// A reported photo or video stays openable from the report notices, also
// after staff deleted the message (Discord removes its own link then).

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('reported photos and videos are copied to Cloudy links; the notice links them', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudy-report-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.CLOUDY_EMBED_MEDIA_DIR = dir;
  process.env.CLOUDY_EMBED_MEDIA_BASE_URL = 'https://cloudy.test';
  t.after(() => { delete process.env.CLOUDY_EMBED_MEDIA_DIR; delete process.env.CLOUDY_EMBED_MEDIA_BASE_URL; });
  const fetchFile = async url => new Response(url.endsWith('.mp4') ? Buffer.from('video bytes') : PNG,
    { headers: { 'content-type': url.endsWith('.mp4') ? 'video/mp4' : 'image/png' } });
  const message = { attachments: new Collection([
    ['1', { name: 'photo.png', contentType: 'image/png', size: PNG.length, url: 'https://cdn.discordapp.com/attachments/1/2/photo.png' }],
    ['2', { name: 'clip.mp4', contentType: 'video/mp4', size: 11, url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4' }],
  ]) };
  const kept = await preserveReportAttachments(message, { fetchFile });
  assert.equal(kept.length, 2);
  assert.equal(kept[0].name, 'photo.png');
  assert.match(kept[0].url, /^https:\/\/cloudy\.test\/cloudy-embed-media\/[0-9a-f]{64}\.png$/);
  assert.equal(kept[1].name, 'clip.mp4');
  assert.match(kept[1].url, /^https:\/\/cloudy\.test\/deleted-media\/[A-Za-z0-9_-]{32}$/);
  assert.ok((await readdir(dir)).length > 0);
  assert.deepEqual(reportAttachmentLines(kept), [`[photo.png](${kept[0].url})`, `[clip.mp4](${kept[1].url})`]);
});

test('without Cloudy media storage the original Discord link is kept; no attachments means nothing', async () => {
  delete process.env.CLOUDY_EMBED_MEDIA_DIR;
  const url = 'https://cdn.discordapp.com/attachments/1/2/photo.png';
  const kept = await preserveReportAttachments({ attachments: new Collection([['1', { name: 'photo.png', contentType: 'image/png', url }]]) },
    { fetchFile: async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }) });
  assert.deepEqual(kept, [{ name: 'photo.png', url }]);
  assert.deepEqual(await preserveReportAttachments({ attachments: new Collection() }), []);
  assert.deepEqual(reportAttachmentLines(undefined), []);
});
