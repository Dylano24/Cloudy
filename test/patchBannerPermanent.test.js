import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { preparePatchNotesBanner } from '../src/services/patchNotesBannerService.js';
import { buildRustPatchPayload } from '../src/services/rustPatchNotesService.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('the Rust update banner is a permanent link, not an uploaded file that shows twice after an edit', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudy-media-'));
  const previous = process.env.CLOUDY_EMBED_MEDIA_DIR;
  process.env.CLOUDY_EMBED_MEDIA_DIR = dir;
  t.mock.method(globalThis, 'fetch', async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
  try {
    const banner = await preparePatchNotesBanner({ image: 'https://files.facepunch.com/a.png', link: 'https://rust.facepunch.com/news/x' });
    assert.equal(banner.file, null);
    assert.match(banner.image.url, /^https:\/\/.+\/cloudy-embed-media\/[a-f0-9]{64}\.png$/);
    const payload = buildRustPatchPayload({ title: 'T', link: 'https://rust.facepunch.com/news/x', body: 'B' }, banner);
    assert.deepEqual(payload.files, []);
    assert.equal(payload.embeds[0].toJSON().image.url, banner.image.url);
  } finally {
    if (previous === undefined) delete process.env.CLOUDY_EMBED_MEDIA_DIR; else process.env.CLOUDY_EMBED_MEDIA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
