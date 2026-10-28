import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { startRustPatchNotes } from '../src/services/rustPatchNotesService.js';
import { checkForNitradoUpdate } from '../src/events/nitradoPatchNotesReady.js';

const rustLink = 'https://rust.facepunch.com/news/halloween-2026/';
const rustImage = 'https://files.facepunch.com/jen/2026/October/darkness-falls-branding.png';
const nitradoLink = 'https://server.nitrado.net/en-US/news/rust-test-update';
const nitradoImage = 'https://newsimg.nitrado.net/2026/10/rust.jpg';
// Real PNG signature and image bytes; the network alone is stubbed.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const settle = () => new Promise(resolve => { setImmediate(resolve); });

function fixture(source, { existing = false, stored = false } = {}) {
  const link = source === 'rust' ? rustLink : nitradoLink;
  const id = source === 'rust' ? '1533886914459861103' : '1539397467647377530';
  const values = new Map();
  const sends = []; const edits = [];
  const data = { title: 'Owner saved title', url: link, description: 'Owner saved body', color: 123, ...(source === 'nitrado' ? { thumbnail: { url: 'https://example.com/logo.png' } } : {}), footer: { text: 'Owner footer' } };
  const history = new Collection();
  if (existing) history.set('existing', { id: 'existing', author: { id: 'bot' }, embeds: [{ ...data, toJSON: () => data }], attachments: new Collection([['keep', { id: 'keep' }]]), edit: async payload => { edits.push(payload); data.image = payload.embeds[0].image; } });
  const channel = { id, isTextBased: () => true, messages: { fetch: async () => history }, send: async payload => { sends.push(payload); } };
  const client = { user: { id: 'bot' }, isReady: () => true, channels: { cache: new Collection([[id, channel]]) }, guilds: { cache: new Collection() }, db: { get: async key => values.get(key) || (stored ? link : null), set: async (key, value) => values.set(key, value) } };
  return { client, sends, edits, values, data };
}

function network(t, { unavailable = false, primaryImage = false } = {}) {
  let imageUnavailable = unavailable;
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('/rss/news')) return { ok: true, text: async () => `<rss><item><title>Halloween 2026</title><link>${rustLink}</link><description>Official event</description>${primaryImage ? `<enclosure type="image/png" url="${rustImage}"/>` : ''}</item></rss>` };
    if (String(url).includes('newsapi.nitrado.net')) return { ok: true, json: async () => ({ data: { posts: { edges: [{ node: { title: 'Rust test update', slug: 'rust-test-update', date: '2026-10-22T18:00:00Z', excerpt: 'Official update', ...(primaryImage ? { featuredImage: { node: { sourceUrl: nitradoImage } } } : {}) } }] } } }) };
    if (url === rustLink) return { ok: true, text: async () => `<meta property="og:image" content=""><meta property="twitter:image" content=""><img src="https://files.facepunch.com/logo.svg"><img src="${rustImage}" class="hero_patch-branding" alt="Halloween 2026">` };
    if (url === nitradoLink) return { ok: true, text: async () => `<meta content="${nitradoImage}" property="og:image">` };
    if (url === rustImage || url === nitradoImage) return { ok: true, headers: new Headers({ 'content-type': imageUnavailable ? 'text/html' : 'image/png' }), arrayBuffer: async () => imageUnavailable ? Buffer.from('<html>Error</html>') : png };
    throw new Error(`Unexpected request ${url}`);
  });
  return { recover: () => { imageUnavailable = false; } };
}

async function check(source, client, t) {
  if (source === 'nitrado') return checkForNitradoUpdate(client);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  startRustPatchNotes(client);
  await settle();
}

for (const source of ['rust', 'nitrado']) {
  test(`${source}: missing feed/API image is recovered from the same article and uploaded with the post`, async t => {
    network(t);
    const f = fixture(source);
    await check(source, f.client, t);
    assert.equal(f.sends.length, 1);
    const payload = f.sends[0];
    assert.match(payload.embeds[0].toJSON().image?.url || '', /^attachment:\/\//);
    assert.equal(payload.files.length, 1);
    assert.deepEqual(payload.files[0].attachment, png);
  });

  test(`${source}: unavailable image never sends or advances deduplication state`, async t => {
    network(t, { unavailable: true, primaryImage: true });
    const f = fixture(source);
    await check(source, f.client, t);
    assert.equal(f.sends.length, 0);
    assert.equal(f.values.size, 0);
  });

  test(`${source}: already posted latest update receives only its missing banner even when its link is stored`, async t => {
    network(t);
    const f = fixture(source, { existing: true, stored: true });
    const before = structuredClone(f.data);
    await check(source, f.client, t);
    assert.equal(f.sends.length, 0);
    assert.equal(f.edits.length, 1);
    const { image, ...rest } = f.edits[0].embeds[0];
    assert.deepEqual(rest, before);
    assert.match(image.url, /^attachment:\/\//);
    assert.deepEqual(f.edits[0].attachments, [{ id: 'keep' }]);
  });

  test(`${source}: existing owner banner is preserved without downloading another image`, async t => {
    network(t, { unavailable: true });
    const f = fixture(source, { existing: true, stored: true });
    f.data.image = { url: 'https://example.com/owner-banner.png' };
    await check(source, f.client, t);
    assert.equal(f.edits.length, 0);
    assert.equal(f.sends.length, 0);
  });
}

test('banner-only repair bypasses the real global message edit template preparation', async t => {
  network(t);
  const { prepareMessageEditPayload } = await import('../src/events/fullResponseCatalogReady.js');
  const { primeSystemEmbedTemplateData } = await import('../src/services/systemEmbedCatalogService.js');
  const { repairMissingPatchBanner } = await import('../src/services/patchNotesBannerService.js');
  primeSystemEmbedTemplateData('owner saved title', 'patches/repair', { title: 'Owner saved title', color: 456, footer: { text: 'Stale catalog footer' } });
  const original = { title: 'Owner saved title', url: rustLink, color: 123, footer: { text: 'Owner footer' } };
  let outgoing;
  const message = { id: 'repair-wrapper', guildId: 'guild', channelId: 'channel', client: { user: { id: 'bot' } }, author: { id: 'bot' }, channel: { name: 'patches/repair' }, embeds: [{ toJSON: () => original }],
    edit: async payload => { outgoing = prepareMessageEditPayload(message, payload); } };
  await repairMissingPatchBanner(message, { link: rustLink });
  assert.equal(outgoing.embeds[0].color, 123);
  assert.equal(outgoing.embeds[0].footer.text, 'Owner footer');
});

test('banner repair rereads the message after download so a concurrent owner Save is preserved', async t => {
  network(t);
  const { repairMissingPatchBanner } = await import('../src/services/patchNotesBannerService.js');
  const older = { title: 'Older snapshot', url: rustLink };
  const saved = { title: 'Saved during download', url: rustLink, description: 'New owner text' };
  let outgoing;
  const message = { id: 'repair-save', guildId: 'guild', channelId: 'channel', embeds: [{ toJSON: () => older }], fetch: async () => ({ embeds: [{ toJSON: () => saved }], edit: async payload => { outgoing = payload; } }), edit: async payload => { outgoing = payload; } };
  await repairMissingPatchBanner(message, { link: rustLink });
  assert.equal(outgoing.embeds[0].title, 'Saved during download');
  assert.equal(outgoing.embeds[0].description, 'New owner text');
});

for (const source of ['rust', 'nitrado']) {
  test(`${source}: an image outage retries the same update once the banner recovers`, async t => {
    const upstream = network(t, { unavailable: true, primaryImage: true });
    const f = fixture(source);
    await check(source, f.client, t);
    assert.equal(f.sends.length, 0);
    upstream.recover();
    if (source === 'rust') {
      t.mock.timers.tick(60 * 1000);
      await settle();
    } else await checkForNitradoUpdate(f.client);
    assert.equal(f.sends.length, 1);
    assert.equal(f.values.size, 1);
  });
}

test('Rust feed outage cannot announce an obsolete hardcoded patch', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Source unavailable'); });
  const f = fixture('rust');
  await check('rust', f.client, t);
  assert.equal(f.sends.length, 0);
  assert.equal(f.values.size, 0);
});
